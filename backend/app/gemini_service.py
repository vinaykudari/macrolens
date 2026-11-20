"""Gemini multimodal food photo analysis service with SDK + urllib REST fallback."""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover - allows standalone stdlib usage/testing

    class HTTPException(Exception):  # type: ignore[no-redef]
        def __init__(self, status_code: int, detail: str) -> None:
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail


try:
    from google import genai
    from google.genai import types
except ImportError:  # pragma: no cover - falls back to direct REST call
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]

try:
    from app.config import settings as _settings
except ImportError:  # pragma: no cover - allows standalone stdlib usage/testing
    _settings = None  # type: ignore[assignment]


DEFAULT_GEMINI_MODEL = "gemini-4-carbon"
GEMINI_REST_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# Isolated prompt constants for easy benchmarking and tuning against real food photos.
GEMINI_SYSTEM_INSTRUCTION = """You are an expert sports nutritionist and visual food portion analyst.
Analyze the provided meal photo and estimate calories and macronutrients as accurately as possible.

Follow these rules strictly:
1. Reference-object scale calibration & non-consumed items:
   - Scan the ENTIRE image frame (plate, bowl, edges, table surface, utensils, hands, background) for any everyday reference object of known physical size (e.g., teaspoon, tablespoon, dinner fork, table knife, chopsticks, smartphone, coffee mug, standard dinner plate ~26 cm, salad plate ~20 cm, credit/ID card, beverage/soda can, water bottle, or human hand/palm/thumb).
   - Record the best scale anchor found in `detected_reference` (e.g., "tablespoon next to bowl", "smartphone beside plate", "sealed soda can beside plate", "standard dinner plate"), or null if no reliable scale cue is visible.
   - Use that reference object's real-world dimensions to calibrate food portion sizes, depth, and `estimated_grams` for every item.
   - Do NOT include non-food reference objects (utensils, phones, cards, hands) OR sealed/unopened/background reference drinks (e.g., an unopened soda can placed beside a dish for scale) in `items` or calorie/macro totals unless the user note explicitly states they consumed it.

2. Packaged foods, nutrition labels & multi-serving containers:
   - If the photo shows packaged items (e.g., protein bar, yogurt cup, bottled shake, snack bag) or a readable Nutrition Facts label / brand name, read the label or product specifics directly and anchor your calorie/macro calculations to those exact numbers, scaled to the consumed portion.
   - When a photo shows a multi-serving container or multipack box (e.g., a "32 oz tub" of yogurt/ice cream or a "12 Bars" box), estimate ONE standard serving or ONE single unit by default unless the user's note specifies otherwise (e.g., "ate 2 bars" or "half the tub"), and clearly state the assumed 1-serving / 1-unit basis in both `portion_description` and `notes`.

3. Side sauces, dressings & cooking fats:
   - Separate side sauce cups, dips, and dressing ramekins (e.g., spicy mayo, ranch, soy glaze, salsa, chutney) into their own dedicated `items[]` entry so the user can easily adjust or delete them independently.
   - Account realistically for visible butter, oil sheen, glazes, or cooking fats on cooked proteins, veggies, rice, or pasta (either within the dish or as a clear line item when distinct).

4. User textual description, hidden ingredients & partial consumption:
   - Treat the user's textual description (`note`) as AUTHORITATIVE GROUND TRUTH for ingredients, preparation details, or modifiers that cannot be visually determined from the photo (e.g., "oat milk latte with 1 pump vanilla" vs "black iced coffee", milk type, sugar/syrups, cooking oil/butter, protein powder scoop, or "ate half").
   - Combine BOTH visual cues from the photo (e.g., cup size, plate fill level, scale reference object) AND the user's textual description + `reference_hint`.
   - When the user indicates partial consumption (e.g., "only ate half"), reflect the actually consumed amount in `items`, `estimated_grams`, `total`, and `notes`.

5. Output structure & natural item grouping:
   - Group distinct meal components at natural human-countable granularity (e.g., "3 eggs" with `portion_description` "3 large eggs" rather than 3 separate egg lines or splitting whites/yolks; "1 bowl oatmeal" for a bowl of oats; "1 medium banana"), while keeping separate side sauces/dips in their own entry.
   - Give each item its own accurate `estimated_grams`, `calories`, `protein_g`, `carbs_g`, and `fat_g`.
   - Ensure `total` equals the sum of all `items` and calories stay consistent with macros (~4*protein + 4*carbs + 9*fat).
   - Set `confidence` to "high" (clear scale cue or readable nutrition label and unobstructed food), "medium" (reasonable visual cues with minor uncertainty), or "low" (occluded, blurry, dark, ambiguous oils/sauces, or no scale cue).
   - Keep `notes` concise and informative, summarizing how scale calibration, labels, multi-serving defaults, side sauces, or user notes were applied.
"""


def build_meal_analysis_prompt(note: str = "", reference_hint: str = "") -> str:
    """Build the user prompt sent alongside the meal image."""
    lines = [
        "Inspect the entire photo carefully for any everyday reference object (spoon, fork, knife, "
        "smartphone, mug, plate, credit card, sealed can, hand, etc.) and any visible nutrition label or brand packaging.",
        "Use reference objects only for scale calibration (exclude non-food items and unopened background reference drinks unless noted as consumed).",
        "Default multi-serving tubs or multipack boxes to 1 standard serving/unit unless noted otherwise, and list side sauce cups/ramekins as separate items.",
        "Estimate each consumed food component in grams along with calories, protein_g, carbs_g, and fat_g.",
    ]
    cleaned_hint = reference_hint.strip()
    cleaned_note = note.strip()
    if cleaned_hint:
        lines.append(f"User reference_hint: {cleaned_hint}")
    if cleaned_note:
        lines.append(
            f"Authoritative user textual description / note (use for non-visible ingredients, "
            f"milk/sweetener/oil choices, or consumed fraction alongside visual size cues): {cleaned_note}"
        )
    lines.append(
        "Return strict JSON matching the required schema with keys: "
        "meal_name, detected_reference, confidence, notes, total, items."
    )
    return "\n".join(lines)


GEMINI_TEXT_SYSTEM_INSTRUCTION = """You are an expert sports nutritionist and meal macro estimator.
Estimate accurate calories and macronutrients from the user's free-text description of a meal or snack.

Follow these rules strictly:
1. Natural human-countable item grouping:
   - Group distinct meal components at natural human-countable granularity (e.g., "3 scrambled eggs", "1 bowl oats", "1 medium banana", "2 slices sourdough toast") rather than splitting individual eggs or raw whites/yolks.
   - Keep separate sauces, dressings, or toppings distinct when meaningful so the user can adjust them easily.
   - Give each item realistic `portion_description`, `estimated_grams`, `calories`, `protein_g`, `carbs_g`, and `fat_g`.

2. Cooking fats, oils, dressings & implicit ingredients:
   - Account realistically for typical cooking oil/butter, sauces, or restaurant preparation when implied (e.g., scrambled eggs cooked with butter/oil, restaurant stir-fry, dressed salad) unless the user specifies dry/plain/no oil.
   - Clearly document portion assumptions and any assumed cooking fats or dressings in `notes`.

3. Reference & output structure:
   - Because this is text-only with no photo, always set `detected_reference` to null.
   - Ensure `total` equals the sum of all `items` and calories stay consistent with macros (~4*protein + 4*carbs + 9*fat).
   - Set `confidence` to "high" (exact weights, counts, or branded items provided), "medium" (typical meal description with standard portion assumptions), or "low" (very vague or ambiguous description).
"""


def build_meal_text_prompt(description: str) -> str:
    """Build the user prompt for text-only meal calorie and macro estimation."""
    return (
        f"Meal description: {description.strip()}\n"
        "Estimate each natural food component in grams along with calories, protein_g, carbs_g, and fat_g. "
        "Set detected_reference to null and document any assumed standard portions or cooking fats in notes. "
        "Return strict JSON matching the required schema with keys: "
        "meal_name, detected_reference, confidence, notes, total, items."
    )


GEMINI_REFINE_SYSTEM_INSTRUCTION = """You are an expert sports nutritionist updating an existing logged meal based on a user's natural-language correction.
Apply the user's requested change precisely while preserving unmodified items from the current meal.
When a photo is supplied, use it as visual context for the original meal. The user's correction and current meal state take precedence over the photo, including food the user says was not eaten.

Follow these rules strictly:
1. Preserve & modify cleanly:
   - Keep existing `items[]` that the user did not change, and update, scale, remove, or add items according to their `instruction` (e.g., "actually had 2 eggs instead of 3", "also had a banana", "half the rice", "no dressing").
   - Group items at natural human-countable granularity (e.g., "2 scrambled eggs", "1 medium banana", "1 bowl oats").

2. Output consistency:
   - Recompute `total` so it equals the sum of all updated `items` and matches ~4*protein + 4*carbs + 9*fat.
   - Update `meal_name` if appropriate (or keep the original meal name when still accurate).
   - Briefly explain the applied correction in `notes` and set `confidence` ("high", "medium", or "low").
"""


def build_meal_refine_prompt(
    *,
    meal_name: str,
    current_items: list[dict[str, Any]],
    current_notes: str,
    instruction: str,
    current_totals: dict[str, float] | None = None,
) -> str:
    """Build the user prompt for refining an existing meal from plain-text instructions."""
    payload: dict[str, Any] = {
        "current_meal_name": meal_name,
        "current_notes": current_notes,
        "current_items": current_items,
    }
    if current_totals is not None:
        payload["current_totals"] = current_totals

    return (
        f"Current meal JSON:\n{json.dumps(payload, indent=2)}\n\n"
        f"User refinement instruction: {instruction.strip()}\n"
        "Apply this change and return the complete updated meal JSON matching the schema with keys: "
        "meal_name, detected_reference, confidence, notes, total, items."
    )


GEMINI_TRANSCRIBE_SYSTEM_INSTRUCTION = """You are an accurate speech-to-text transcription assistant for a calorie and macro tracking app.
Transcribe the speaker's audio recording into clean, natural English text.

Follow these rules strictly:
1. Preserve nutrition & meal specifics verbatim:
   - Keep exact item counts, weights, ounces, cups, brand names, coffee milk/syrup modifiers (e.g., "oat milk latte with 1 pump vanilla"), cooking fats, and edit instructions (e.g., "ate 2 eggs instead of 3").
2. Clean readable output:
   - Remove filler sounds ("um", "uh") while keeping natural punctuation and numbers clear.
   - Return strict JSON with a single key: {"transcript": "..."}.
"""

GEMINI_TRANSCRIBE_PROMPT = (
    "Transcribe this spoken meal description, photo note, or meal refinement instruction into clean "
    "natural English text. Return strict JSON with key: transcript."
)

GEMINI_TRANSCRIBE_REST_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "required": ["transcript"],
    "properties": {
        "transcript": {"type": "STRING"},
    },
}


def _build_sdk_transcribe_schema() -> Any:
    """Build google.genai.types.Schema for audio transcription JSON output."""
    return types.Schema(
        type=types.Type.OBJECT,
        required=["transcript"],
        properties={
            "transcript": types.Schema(type=types.Type.STRING),
        },
    )


GEMINI_REST_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "required": ["meal_name", "confidence", "notes", "total", "items"],
    "properties": {
        "meal_name": {"type": "STRING"},
        "detected_reference": {"type": "STRING", "nullable": True},
        "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]},
        "notes": {"type": "STRING"},
        "total": {
            "type": "OBJECT",
            "required": ["calories", "protein_g", "carbs_g", "fat_g"],
            "properties": {
                "calories": {"type": "NUMBER"},
                "protein_g": {"type": "NUMBER"},
                "carbs_g": {"type": "NUMBER"},
                "fat_g": {"type": "NUMBER"},
            },
        },
        "items": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": [
                    "name",
                    "portion_description",
                    "estimated_grams",
                    "calories",
                    "protein_g",
                    "carbs_g",
                    "fat_g",
                ],
                "properties": {
                    "name": {"type": "STRING"},
                    "portion_description": {"type": "STRING"},
                    "estimated_grams": {"type": "NUMBER"},
                    "calories": {"type": "NUMBER"},
                    "protein_g": {"type": "NUMBER"},
                    "carbs_g": {"type": "NUMBER"},
                    "fat_g": {"type": "NUMBER"},
                },
            },
        },
    },
}


def _build_sdk_response_schema() -> Any:
    """Build google.genai.types.Schema matching GEMINI_REST_RESPONSE_SCHEMA."""
    return types.Schema(
        type=types.Type.OBJECT,
        required=["meal_name", "confidence", "notes", "total", "items"],
        properties={
            "meal_name": types.Schema(type=types.Type.STRING),
            "detected_reference": types.Schema(type=types.Type.STRING, nullable=True),
            "confidence": types.Schema(type=types.Type.STRING, enum=["high", "medium", "low"]),
            "notes": types.Schema(type=types.Type.STRING),
            "total": types.Schema(
                type=types.Type.OBJECT,
                required=["calories", "protein_g", "carbs_g", "fat_g"],
                properties={
                    "calories": types.Schema(type=types.Type.NUMBER),
                    "protein_g": types.Schema(type=types.Type.NUMBER),
                    "carbs_g": types.Schema(type=types.Type.NUMBER),
                    "fat_g": types.Schema(type=types.Type.NUMBER),
                },
            ),
            "items": types.Schema(
                type=types.Type.ARRAY,
                items=types.Schema(
                    type=types.Type.OBJECT,
                    required=[
                        "name",
                        "portion_description",
                        "estimated_grams",
                        "calories",
                        "protein_g",
                        "carbs_g",
                        "fat_g",
                    ],
                    properties={
                        "name": types.Schema(type=types.Type.STRING),
                        "portion_description": types.Schema(type=types.Type.STRING),
                        "estimated_grams": types.Schema(type=types.Type.NUMBER),
                        "calories": types.Schema(type=types.Type.NUMBER),
                        "protein_g": types.Schema(type=types.Type.NUMBER),
                        "carbs_g": types.Schema(type=types.Type.NUMBER),
                        "fat_g": types.Schema(type=types.Type.NUMBER),
                    },
                ),
            ),
        },
    )


_AUDIO_MIME_ALIASES: dict[str, str] = {
    "audio/mp4": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "video/mp4": "audio/mp4",
    "audio/webm": "audio/webm",
    "video/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "application/ogg": "audio/ogg",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/aac": "audio/aac",
    "audio/flac": "audio/flac",
}


def detect_audio_mime_type(data: bytes, declared_content_type: str | None = None) -> str | None:
    """Validate uploaded audio bytes/MIME type for browser MediaRecorder & mobile formats."""
    if not data:
        return None

    # Reject obvious non-audio file signatures even if content-type was spoofed.
    if (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith((b"GIF87a", b"GIF89a"))
        or data.startswith(b"%PDF-")
        or (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP")
    ):
        return None

    cleaned = (declared_content_type or "").split(";")[0].strip().lower()
    if cleaned in _AUDIO_MIME_ALIASES:
        return _AUDIO_MIME_ALIASES[cleaned]

    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] not in (
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    ):
        return "audio/mp4"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"fLaC"):
        return "audio/flac"
    if data.startswith(b"ID3"):
        return "audio/mpeg"
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "audio/mpeg"
    return None


def parse_gemini_transcript_response(raw_text: str) -> dict[str, str]:
    """Parse structured JSON transcript returned by Gemini audio transcription."""
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError("Gemini returned an empty transcription response")

    cleaned = _strip_markdown_fences(raw_text)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Gemini returned invalid transcript JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("Gemini transcript JSON must be an object")

    transcript = str(data.get("transcript") or "").strip()
    if not transcript:
        raise ValueError("Gemini returned an empty transcript")
    return {"transcript": transcript}


def detect_image_mime_type(data: bytes, declared_content_type: str | None = None) -> str | None:
    """Validate uploaded image bytes and resolve a safe image MIME type."""
    if not data:
        return None

    sniffed: str | None = None
    if data.startswith(b"\xff\xd8\xff"):
        sniffed = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        sniffed = "image/png"
    elif data.startswith((b"GIF87a", b"GIF89a")):
        sniffed = "image/gif"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        sniffed = "image/webp"
    elif len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in (
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    ):
        sniffed = "image/heic"

    if sniffed is not None:
        return sniffed

    cleaned = (declared_content_type or "").split(";")[0].strip().lower()
    if cleaned.startswith("image/"):
        return cleaned
    return None


def _strip_markdown_fences(raw_text: str) -> str:
    stripped = raw_text.strip()
    fence_match = re.match(r"^```(?:json)?\s*\n?(.*?)\n?```$", stripped, flags=re.DOTALL | re.IGNORECASE)
    if fence_match:
        return fence_match.group(1).strip()
    return stripped


def _non_negative_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed or parsed < 0:  # NaN or negative
        return 0.0
    return round(parsed, 1)


def parse_gemini_analysis_response(raw_text: str) -> dict[str, Any]:
    """Parse and normalize structured JSON returned by Gemini into the API response shape."""
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError("Gemini returned an empty response")

    cleaned = _strip_markdown_fences(raw_text)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Gemini returned invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("Gemini response JSON must be an object")

    meal_name = str(data.get("meal_name") or "").strip() or "Analyzed Meal"

    raw_ref = data.get("detected_reference")
    if raw_ref is None:
        detected_reference = None
    else:
        ref_str = str(raw_ref).strip()
        detected_reference = None if ref_str.lower() in ("", "none", "null", "n/a") else ref_str

    raw_confidence = str(data.get("confidence") or "medium").strip().lower()
    confidence = raw_confidence if raw_confidence in ("high", "medium", "low") else "medium"

    notes = str(data.get("notes") or "").strip()

    raw_items = data.get("items")
    if not isinstance(raw_items, list):
        raw_items = []

    normalized_items: list[dict[str, Any]] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        item_name = str(raw_item.get("name") or "").strip() or "Food item"
        normalized_items.append(
            {
                "name": item_name,
                "portion_description": str(raw_item.get("portion_description") or "").strip(),
                "estimated_grams": _non_negative_float(raw_item.get("estimated_grams"), 0.0),
                "calories": _non_negative_float(raw_item.get("calories"), 0.0),
                "protein_g": _non_negative_float(raw_item.get("protein_g"), 0.0),
                "carbs_g": _non_negative_float(raw_item.get("carbs_g"), 0.0),
                "fat_g": _non_negative_float(raw_item.get("fat_g"), 0.0),
            }
        )

    item_sums = {
        key: round(sum(item[key] for item in normalized_items), 1)
        for key in ("calories", "protein_g", "carbs_g", "fat_g")
    }

    raw_total = data.get("total")
    if isinstance(raw_total, dict):
        total = {
            key: _non_negative_float(raw_total.get(key), item_sums[key])
            if raw_total.get(key) is not None
            else item_sums[key]
            for key in ("calories", "protein_g", "carbs_g", "fat_g")
        }
        if (
            normalized_items
            and total["calories"] == 0.0
            and total["protein_g"] == 0.0
            and item_sums["calories"] > 0.0
        ):
            total = item_sums
    else:
        total = item_sums

    return {
        "meal_name": meal_name,
        "detected_reference": detected_reference,
        "confidence": confidence,
        "notes": notes,
        "total": total,
        "items": normalized_items,
    }


def _resolve_gemini_config(
    api_key: str | None = None,
    model: str | None = None,
) -> tuple[str, str]:
    if api_key is not None:
        resolved_key = api_key.strip()
    elif _settings is not None:
        resolved_key = _settings.effective_gemini_api_key
    else:
        resolved_key = (
            os.getenv("GEMINI_API_KEY", "").strip()
            or os.getenv("GOOGLE_API_KEY", "").strip()
        )

    if model is not None and model.strip():
        resolved_model = model.strip()
    elif _settings is not None:
        resolved_model = _settings.effective_gemini_model
    else:
        resolved_model = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL

    return resolved_key, resolved_model


def _call_gemini_sdk(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    prompt: str,
    media_bytes: bytes | None = None,
    mime_type: str | None = None,
    sdk_schema: Any = None,
) -> str:
    client = genai.Client(api_key=api_key)
    contents: list[Any] = [prompt]
    if media_bytes is not None and mime_type is not None:
        contents.append(types.Part.from_bytes(data=media_bytes, mime_type=mime_type))

    config_kwargs: dict[str, Any] = {
        "system_instruction": system_instruction,
        "response_mime_type": "application/json",
        "response_schema": sdk_schema if sdk_schema is not None else _build_sdk_response_schema(),
        "temperature": 0.2,
    }
    if model.lower().startswith("gemini-3") and hasattr(types, "ThinkingConfig"):
        try:
            config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="minimal")
        except TypeError:
            pass

    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**config_kwargs),
    )
    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        return text
    parsed = getattr(response, "parsed", None)
    if parsed is not None:
        return json.dumps(parsed)
    raise ValueError("Gemini SDK returned no text content")


def _extract_rest_response_text(response_json: dict[str, Any]) -> str:
    candidates = response_json.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Gemini REST response contained no candidates")
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        raise ValueError("Gemini REST response contained no content parts")
    text_chunks = [
        part["text"]
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    combined = "".join(text_chunks).strip()
    if not combined:
        raise ValueError("Gemini REST response contained no text output")
    return combined


def _gemini_limit_error(message: str) -> HTTPException:
    """Translate provider limits into actionable messages without exposing raw errors."""
    lowered = message.lower()
    if "spending cap" in lowered or "spend cap" in lowered:
        return HTTPException(
            status_code=503,
            detail="AI is unavailable because the Google AI monthly spending cap was reached. Update the cap in Google AI Studio, then try again.",
        )
    return HTTPException(
        status_code=503,
        detail="AI has reached a usage limit. Please try again later.",
    )


def _call_gemini_rest(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    prompt: str,
    media_bytes: bytes | None = None,
    mime_type: str | None = None,
    rest_schema: dict[str, Any] | None = None,
    timeout_seconds: float = 45.0,
) -> str:
    encoded_model = urllib.parse.quote(model, safe="")
    url = f"{GEMINI_REST_BASE_URL}/{encoded_model}:generateContent"

    generation_config: dict[str, Any] = {
        "responseMimeType": "application/json",
        "responseSchema": rest_schema if rest_schema is not None else GEMINI_REST_RESPONSE_SCHEMA,
        "temperature": 0.2,
    }
    if model.lower().startswith("gemini-3"):
        generation_config["thinkingConfig"] = {"thinkingLevel": "minimal"}

    parts: list[dict[str, Any]] = [{"text": prompt}]
    if media_bytes is not None and mime_type is not None:
        parts.append(
            {
                "inlineData": {
                    "mimeType": mime_type,
                    "data": base64.b64encode(media_bytes).decode("ascii"),
                }
            }
        )

    payload = {
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation_config,
    }

    req = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        if exc.code == 429:
            raise _gemini_limit_error(err_body) from exc
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API error ({exc.code}): {err_body[:300] or exc.reason}",
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach Gemini API: {exc}",
        ) from exc

    try:
        parsed_body = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail="Gemini REST endpoint returned malformed JSON envelope",
        ) from exc

    return _extract_rest_response_text(parsed_body)


def _call_gemini_raw(
    *,
    system_instruction: str,
    prompt: str,
    media_bytes: bytes | None = None,
    mime_type: str | None = None,
    rest_schema: dict[str, Any] | None = None,
    sdk_schema_builder: Any = None,
    api_key: str | None = None,
    model: str | None = None,
) -> str:
    resolved_key, resolved_model = _resolve_gemini_config(api_key=api_key, model=model)
    if not resolved_key:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server",
        )

    if genai is not None and types is not None:
        sdk_schema = sdk_schema_builder() if sdk_schema_builder is not None else _build_sdk_response_schema()
        try:
            return _call_gemini_sdk(
                api_key=resolved_key,
                model=resolved_model,
                system_instruction=system_instruction,
                prompt=prompt,
                media_bytes=media_bytes,
                mime_type=mime_type,
                sdk_schema=sdk_schema,
            )
        except Exception as exc:
            if getattr(exc, "code", None) == 429:
                raise _gemini_limit_error(str(getattr(exc, "message", "") or exc)) from exc
            raise

    return _call_gemini_rest(
        api_key=resolved_key,
        model=resolved_model,
        system_instruction=system_instruction,
        prompt=prompt,
        media_bytes=media_bytes,
        mime_type=mime_type,
        rest_schema=rest_schema,
    )


def _execute_gemini_analysis(
    *,
    system_instruction: str,
    prompt: str,
    image_bytes: bytes | None = None,
    mime_type: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    force_null_reference: bool = False,
) -> dict[str, Any]:
    try:
        raw_text = _call_gemini_raw(
            system_instruction=system_instruction,
            prompt=prompt,
            media_bytes=image_bytes,
            mime_type=mime_type,
            rest_schema=GEMINI_REST_RESPONSE_SCHEMA,
            sdk_schema_builder=_build_sdk_response_schema,
            api_key=api_key,
            model=model,
        )
        parsed = parse_gemini_analysis_response(raw_text)
        if force_null_reference:
            parsed["detected_reference"] = None
        return parsed
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to parse meal analysis from Gemini: {exc}",
        ) from exc
    except Exception as exc:  # pragma: no cover - upstream SDK network/API failures
        raise HTTPException(
            status_code=502,
            detail=f"Gemini meal analysis failed: {exc}",
        ) from exc


def transcribe_meal_audio(
    *,
    audio_bytes: bytes,
    mime_type: str,
    api_key: str | None = None,
    model: str | None = None,
) -> dict[str, str]:
    """Transcribe spoken meal audio via google-genai SDK or direct REST fallback."""
    try:
        raw_text = _call_gemini_raw(
            system_instruction=GEMINI_TRANSCRIBE_SYSTEM_INSTRUCTION,
            prompt=GEMINI_TRANSCRIBE_PROMPT,
            media_bytes=audio_bytes,
            mime_type=mime_type,
            rest_schema=GEMINI_TRANSCRIBE_REST_RESPONSE_SCHEMA,
            sdk_schema_builder=_build_sdk_transcribe_schema,
            api_key=api_key,
            model=model,
        )
        return parse_gemini_transcript_response(raw_text)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to parse audio transcription from Gemini: {exc}",
        ) from exc
    except Exception as exc:  # pragma: no cover - upstream SDK network/API failures
        raise HTTPException(
            status_code=502,
            detail=f"Gemini audio transcription failed: {exc}",
        ) from exc


def analyze_meal_photo(
    *,
    image_bytes: bytes,
    mime_type: str,
    note: str = "",
    reference_hint: str = "",
    api_key: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Analyze a meal photograph via google-genai SDK or direct REST fallback."""
    return _execute_gemini_analysis(
        system_instruction=GEMINI_SYSTEM_INSTRUCTION,
        prompt=build_meal_analysis_prompt(note=note, reference_hint=reference_hint),
        image_bytes=image_bytes,
        mime_type=mime_type,
        api_key=api_key,
        model=model,
    )


def analyze_meal_text(
    *,
    description: str,
    api_key: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Estimate meal calories and macros from a text description via Gemini."""
    return _execute_gemini_analysis(
        system_instruction=GEMINI_TEXT_SYSTEM_INSTRUCTION,
        prompt=build_meal_text_prompt(description),
        api_key=api_key,
        model=model,
        force_null_reference=True,
    )


def refine_meal_from_text(
    *,
    meal_name: str,
    current_items: list[dict[str, Any]],
    current_notes: str,
    instruction: str,
    current_totals: dict[str, float] | None = None,
    image_bytes: bytes | None = None,
    image_mime_type: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Refine an existing logged meal's items and macros from a user's plain-text instruction."""
    return _execute_gemini_analysis(
        system_instruction=GEMINI_REFINE_SYSTEM_INSTRUCTION,
        prompt=build_meal_refine_prompt(
            meal_name=meal_name,
            current_items=current_items,
            current_notes=current_notes,
            instruction=instruction,
            current_totals=current_totals,
        ),
        image_bytes=image_bytes,
        mime_type=image_mime_type,
        api_key=api_key,
        model=model,
    )
