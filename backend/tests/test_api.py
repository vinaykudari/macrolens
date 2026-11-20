"""Comprehensive unit and integration tests for the Macro Tracker FastAPI backend."""

from __future__ import annotations

import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session, sessionmaker

# Ensure `backend/` is importable regardless of how pytest is invoked.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import gemini_service, notification_service  # noqa: E402
from app.auth import TokenError, create_access_token, decode_access_token, hash_pin, verify_pin  # noqa: E402
from app.calibration import calibrate_targets  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import Base, create_db_engine, get_db, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import PushSubscription, User  # noqa: E402


SAMPLE_PROFILE = {
    "height_cm": 178.0,
    "weight_kg": 75.0,
    "age": 30,
    "sex": "male",
    "activity_level": "moderate",
    "goal": "maintain",
}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Provide a FastAPI TestClient backed by an isolated temporary SQLite database."""
    db_path = tmp_path / "test_macro_tracker.db"
    test_engine = create_db_engine(f"sqlite:///{db_path}")
    TestingSessionLocal = sessionmaker(
        bind=test_engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
        class_=Session,
    )
    Base.metadata.create_all(bind=test_engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(settings, "GOOGLE_API_KEY", "")
    monkeypatch.setattr(settings, "GEMINI_MODEL", "gemini-4-carbon")
    monkeypatch.setattr(settings, "COOKIE_SECURE", False)
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "")
    monkeypatch.setattr(settings, "VAPID_KEYS_FILE", str(tmp_path / ".vapid_keys.json"))

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        test_engine.dispose()


def _signup_user(
    client: TestClient,
    *,
    email: str = "alex@example.com",
    pin: str = "1234",
    name: str = "Alex",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resp = client.post(
        "/api/auth/signup",
        json={
            "email": email,
            "pin": pin,
            "name": name,
            "profile": profile or SAMPLE_PROFILE,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Unit tests: Calibration
# ---------------------------------------------------------------------------


def test_calibration_mifflin_st_jeor_and_goals() -> None:
    # Male, 75 kg, 178 cm, age 30:
    # BMR = 10*75 + 6.25*178 - 5*30 + 5 = 750 + 1112.5 - 150 + 5 = 1717.5
    # Moderate (1.55): TDEE = 2662.125 -> maintain = 2662
    maintain = calibrate_targets(**SAMPLE_PROFILE)
    assert maintain.calories == 2662.0
    assert maintain.protein_g == 120.0  # 75 * 1.6
    assert maintain.fat_g == 79.9  # 2662 * 0.27 / 9 = 79.86 -> 79.9
    # remaining = 2662 - 480 - 719.1 = 1462.9 -> /4 = 365.725 -> 365.7
    assert maintain.carbs_g == 365.7

    lose = calibrate_targets(**{**SAMPLE_PROFILE, "goal": "lose"})
    assert lose.calories == 2212.0  # 2662.125 - 450 = 2212.125 -> 2212
    assert lose.protein_g == 150.0  # 75 * 2.0

    gain = calibrate_targets(**{**SAMPLE_PROFILE, "goal": "gain"})
    assert gain.calories == 2962.0  # 2662.125 + 300
    assert gain.protein_g == 135.0  # 75 * 1.8


def test_calibration_clamps_minimum_calories_and_carbs() -> None:
    small = calibrate_targets(
        height_cm=150.0,
        weight_kg=42.0,
        age=65,
        sex="female",
        activity_level="sedentary",
        goal="lose",
    )
    assert small.calories == 1200.0
    assert small.carbs_g >= 50.0

    # Force low remaining carbs so 50g carb floor triggers
    low_carb = calibrate_targets(
        height_cm=150.0,
        weight_kg=120.0,
        age=75,
        sex="female",
        activity_level="sedentary",
        goal="lose",
    )
    assert low_carb.carbs_g >= 50.0


# ---------------------------------------------------------------------------
# Unit tests: Auth crypto (scrypt PIN + HMAC-SHA256 bearer tokens)
# ---------------------------------------------------------------------------


def test_pin_scrypt_hashing_and_verification() -> None:
    h1 = hash_pin("0420")
    h2 = hash_pin("0420")
    assert h1.startswith("scrypt$")
    assert h1 != h2  # unique random salt per hash
    assert verify_pin("0420", h1) is True
    assert verify_pin("0421", h1) is False
    assert verify_pin("0420", "invalid-hash") is False


def test_hmac_bearer_token_roundtrip_tamper_and_expiry() -> None:
    token = create_access_token(user_id=7, email="u@example.com", secret_key="top-secret", expires_seconds=3600)
    claims = decode_access_token(token, secret_key="top-secret")
    assert claims["sub"] == "7"
    assert claims["email"] == "u@example.com"

    with pytest.raises(TokenError):
        decode_access_token(token, secret_key="wrong-secret")

    tampered = token[:-4] + ("AAAA" if not token.endswith("AAAA") else "BBBB")
    with pytest.raises(TokenError):
        decode_access_token(tampered, secret_key="top-secret")

    expired = create_access_token(user_id=7, email="u@example.com", secret_key="top-secret", expires_seconds=-5)
    with pytest.raises(TokenError):
        decode_access_token(expired, secret_key="top-secret")


# ---------------------------------------------------------------------------
# Unit tests: Gemini parsing, prompt isolation & REST fallback
# ---------------------------------------------------------------------------


def test_gemini_json_parsing_fences_and_normalization() -> None:
    fenced = """```json
    {
      "meal_name": "Greek Yogurt Bowl",
      "detected_reference": "none",
      "confidence": "HIGH",
      "notes": "Read label on yogurt cup and used spoon for granola scale.",
      "total": {"calories": 380, "protein_g": 28, "carbs_g": 42, "fat_g": 9},
      "items": [
        {
          "name": "Greek Yogurt",
          "portion_description": "1 cup (170g)",
          "estimated_grams": 170,
          "calories": 150,
          "protein_g": 20,
          "carbs_g": 8,
          "fat_g": 3
        },
        {
          "name": "Granola & Berries",
          "portion_description": "3 tbsp granola + handful blueberries",
          "estimated_grams": 75,
          "calories": 230,
          "protein_g": 8,
          "carbs_g": 34,
          "fat_g": 6
        }
      ]
    }
    ```"""
    parsed = gemini_service.parse_gemini_analysis_response(fenced)
    assert parsed["meal_name"] == "Greek Yogurt Bowl"
    assert parsed["detected_reference"] is None
    assert parsed["confidence"] == "high"
    assert parsed["total"]["calories"] == 380.0
    assert len(parsed["items"]) == 2

    # Missing total falls back to sum of items
    no_total = json.dumps(
        {
            "meal_name": "Protein Bar",
            "detected_reference": "nutrition label",
            "confidence": "high",
            "notes": "Direct label read",
            "items": [
                {
                    "name": "Quest Bar",
                    "portion_description": "1 bar (60g)",
                    "estimated_grams": 60,
                    "calories": 190,
                    "protein_g": 21,
                    "carbs_g": 22,
                    "fat_g": 7,
                }
            ],
        }
    )
    parsed_no_total = gemini_service.parse_gemini_analysis_response(no_total)
    assert parsed_no_total["total"] == {"calories": 190.0, "protein_g": 21.0, "carbs_g": 22.0, "fat_g": 7.0}

    with pytest.raises(ValueError):
        gemini_service.parse_gemini_analysis_response("not valid json")


def test_gemini_prompt_contains_reference_label_and_notes() -> None:
    prompt = gemini_service.build_meal_analysis_prompt(
        note="only ate half",
        reference_hint="spoon next to bowl",
    )
    sys_prompt = gemini_service.GEMINI_SYSTEM_INSTRUCTION.lower()
    assert "only ate half" in prompt
    assert "spoon next to bowl" in prompt
    assert "reference object" in sys_prompt
    assert "nutrition facts label" in sys_prompt
    assert "do not include non-food reference objects" in sys_prompt
    assert "multi-serving" in sys_prompt
    assert "side sauce" in sys_prompt
    assert "natural human-countable granularity" in sys_prompt


def test_gemini_rest_fallback_and_thinking_config(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_requests: list[dict[str, Any]] = []

    class FakeHttpResponse:
        def __init__(self, body: dict[str, Any]) -> None:
            self._raw = json.dumps(body).encode("utf-8")

        def read(self) -> bytes:
            return self._raw

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(req, timeout=0):
        payload = json.loads(req.data.decode("utf-8"))
        headers = {k.lower(): v for k, v in req.header_items()}
        captured_requests.append({"url": req.full_url, "headers": headers, "payload": payload})
        return FakeHttpResponse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "meal_name": "Chicken Rice Bowl",
                                            "detected_reference": "dinner fork beside bowl",
                                            "confidence": "high",
                                            "notes": "Portion calibrated against fork (~19cm).",
                                            "total": {
                                                "calories": 540,
                                                "protein_g": 45,
                                                "carbs_g": 58,
                                                "fat_g": 12,
                                            },
                                            "items": [
                                                {
                                                    "name": "Grilled Chicken Breast",
                                                    "portion_description": "170g sliced",
                                                    "estimated_grams": 170,
                                                    "calories": 280,
                                                    "protein_g": 41,
                                                    "carbs_g": 0,
                                                    "fat_g": 6,
                                                },
                                                {
                                                    "name": "Jasmine Rice",
                                                    "portion_description": "1 cup cooked",
                                                    "estimated_grams": 160,
                                                    "calories": 260,
                                                    "protein_g": 4,
                                                    "carbs_g": 58,
                                                    "fat_g": 6,
                                                },
                                            ],
                                        }
                                    )
                                }
                            ]
                        }
                    }
                ]
            }
        )

    monkeypatch.setattr(gemini_service, "genai", None)
    monkeypatch.setattr(gemini_service, "types", None)
    monkeypatch.setattr(gemini_service.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(settings, "GOOGLE_API_KEY", "")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-key")

    # gemini-4-carbon should NOT force unsupported thinkingLevel=minimal
    res_carbon = gemini_service.analyze_meal_photo(
        image_bytes=b"\xff\xd8\xff\xe0fakejpeg",
        mime_type="image/jpeg",
        note="extra chicken",
        model="gemini-4-carbon",
    )
    assert res_carbon["detected_reference"] == "dinner fork beside bowl"
    assert captured_requests[0]["headers"]["x-goog-api-key"] == "test-google-key"
    assert "thinkingConfig" not in captured_requests[0]["payload"]["generationConfig"]

    # Explicit default call with note/reference_hint sends BOTH text and image inlineData in parts[]
    gemini_service.analyze_meal_photo(
        image_bytes=b"\xff\xd8\xff\xe0fakejpeg",
        mime_type="image/jpeg",
        note="iced oat milk latte, 16 oz",
        reference_hint="spoon beside plate",
        model="gemini-4-carbon",
    )
    sent_parts = captured_requests[1]["payload"]["contents"][0]["parts"]
    assert len(sent_parts) == 2
    assert "iced oat milk latte, 16 oz" in sent_parts[0]["text"]
    assert "spoon beside plate" in sent_parts[0]["text"]
    assert sent_parts[1]["inlineData"]["mimeType"] == "image/jpeg"
    assert len(sent_parts[1]["inlineData"]["data"]) > 0


# ---------------------------------------------------------------------------
# Integration tests: Auth, PIN, Cookie Session, Config, Meals, Dashboard
# ---------------------------------------------------------------------------


def test_health_and_pin_auth_flow_with_cookie_and_bearer(client: TestClient) -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}

    # Invalid PIN formats rejected
    bad_pin = client.post(
        "/api/auth/signup",
        json={"email": "bad@example.com", "pin": "12a", "name": "Bad", "profile": SAMPLE_PROFILE},
    )
    assert bad_pin.status_code == 422

    # Signup succeeds, sets persistent cookie & returns calibrated targets
    signup_data = _signup_user(client, email="Alex@Example.com", pin="0420")
    token = signup_data["access_token"]
    assert signup_data["token_type"] == "bearer"
    assert signup_data["user"]["email"] == "alex@example.com"
    assert signup_data["user"]["targets"]["calories"] == 2662.0
    assert "macro_session" in client.cookies

    # Duplicate email returns 409
    dup = client.post(
        "/api/auth/signup",
        json={"email": "alex@example.com", "pin": "0420", "name": "Alex", "profile": SAMPLE_PROFILE},
    )
    assert dup.status_code == 409

    # Cookie-only session auth works without Authorization header
    me_cookie = client.get("/api/auth/me")
    assert me_cookie.status_code == 200
    assert me_cookie.json()["email"] == "alex@example.com"

    # Logout clears session cookie
    logout_resp = client.post("/api/auth/logout")
    assert logout_resp.status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    # Bearer header still authenticates even without cookie
    me_bearer = client.get("/api/auth/me", headers=_auth_headers(token))
    assert me_bearer.status_code == 200
    assert me_bearer.json()["id"] == signup_data["user"]["id"]

    # Wrong PIN fails login; right PIN succeeds and sets cookie again
    wrong_login = client.post("/api/auth/login", json={"email": "alex@example.com", "pin": "9999"})
    assert wrong_login.status_code == 401

    good_login = client.post("/api/auth/login", json={"email": "alex@example.com", "pin": "0420"})
    assert good_login.status_code == 200
    assert "macro_session" in client.cookies


def test_config_overrides_and_recalibration(client: TestClient) -> None:
    auth = _signup_user(client)
    headers = _auth_headers(auth["access_token"])

    cfg = client.get("/api/config", headers=headers).json()
    assert cfg["targets"]["calories"] == 2662.0
    assert cfg["auto_calibrated_targets"]["calories"] == 2662.0

    # Manual target overrides preserve auto_calibrated_targets
    override_resp = client.put(
        "/api/config",
        headers=headers,
        json={"targets": {"calories": 2100, "protein_g": 175}},
    )
    assert override_resp.status_code == 200
    updated = override_resp.json()
    assert updated["targets"]["calories"] == 2100.0
    assert updated["targets"]["protein_g"] == 175.0
    assert updated["auto_calibrated_targets"]["calories"] == 2662.0

    # Profile update + recalibrate_from_profile=True updates targets
    recal_resp = client.put(
        "/api/config",
        headers=headers,
        json={
            "profile": {"weight_kg": 80.0, "goal": "lose"},
            "recalibrate_from_profile": True,
        },
    )
    assert recal_resp.status_code == 200
    recal = recal_resp.json()
    expected = calibrate_targets(
        height_cm=178.0,
        weight_kg=80.0,
        age=30,
        sex="male",
        activity_level="moderate",
        goal="lose",
    )
    assert recal["targets"]["calories"] == expected.calories
    assert recal["targets"]["protein_g"] == expected.protein_g
    assert recal["auto_calibrated_targets"]["calories"] == expected.calories


def test_analyze_photo_endpoint_missing_key_validation_and_mocked_gemini(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth = _signup_user(client)
    headers = _auth_headers(auth["access_token"])

    fake_jpeg = io.BytesIO(b"\xff\xd8\xff\xe0\x00\x10JFIFfakejpegdata")

    # Missing API key returns 503
    no_key_resp = client.post(
        "/api/meals/analyze",
        headers=headers,
        files={"image": ("meal.jpg", fake_jpeg, "image/jpeg")},
        data={"note": "spoon for scale"},
    )
    assert no_key_resp.status_code == 503
    assert "GEMINI_API_KEY" in no_key_resp.json()["detail"]

    # Empty or non-image file returns 400
    bad_file = client.post(
        "/api/meals/analyze",
        headers=headers,
        files={"image": ("notes.txt", io.BytesIO(b"hello world"), "text/plain")},
    )
    assert bad_file.status_code == 400

    # Mocked Gemini analysis returns structured response
    def fake_analyze(*, image_bytes: bytes, mime_type: str, note: str = "", reference_hint: str = "", **_: Any):
        assert mime_type == "image/jpeg"
        assert note == "only ate half"
        assert reference_hint == "spoon"
        return {
            "meal_name": "Salmon & Rice (Half Portion)",
            "detected_reference": "tablespoon next to plate",
            "confidence": "high",
            "notes": "Halved macros per user note.",
            "total": {"calories": 320.0, "protein_g": 26.0, "carbs_g": 28.0, "fat_g": 11.0},
            "items": [
                {
                    "name": "Baked Salmon",
                    "portion_description": "half fillet (~90g)",
                    "estimated_grams": 90.0,
                    "calories": 190.0,
                    "protein_g": 22.0,
                    "carbs_g": 0.0,
                    "fat_g": 10.5,
                },
                {
                    "name": "Steamed Rice",
                    "portion_description": "0.5 cup (~90g)",
                    "estimated_grams": 90.0,
                    "calories": 130.0,
                    "protein_g": 4.0,
                    "carbs_g": 28.0,
                    "fat_g": 0.5,
                },
            ],
        }

    monkeypatch.setattr("app.main.analyze_meal_photo", fake_analyze)
    ok_resp = client.post(
        "/api/meals/analyze",
        headers=headers,
        files={"image": ("meal.jpg", io.BytesIO(b"\xff\xd8\xff\xe0img"), "image/jpeg")},
        data={"note": "only ate half", "reference_hint": "spoon"},
    )
    assert ok_resp.status_code == 200
    analyzed = ok_resp.json()
    assert analyzed["meal_name"] == "Salmon & Rice (Half Portion)"
    assert analyzed["detected_reference"] == "tablespoon next to plate"
    assert analyzed["total"]["protein_g"] == 26.0
    assert len(analyzed["items"]) == 2

    # Also verify `description` form field combines cleanly for coffee/hidden-ingredient photos
    captured_notes: list[str] = []

    def fake_analyze_coffee(*, image_bytes: bytes, mime_type: str, note: str = "", **_: Any):
        captured_notes.append(note)
        return {
            "meal_name": "Iced Oat Milk Latte",
            "detected_reference": "16 oz cup",
            "confidence": "high",
            "notes": "Used user description for oat milk + vanilla pump.",
            "total": {"calories": 190.0, "protein_g": 4.0, "carbs_g": 27.0, "fat_g": 7.0},
            "items": [
                {
                    "name": "Iced oat milk latte (16 oz)",
                    "portion_description": "16 oz cup with oat milk and 1 pump vanilla",
                    "estimated_grams": 450.0,
                    "calories": 190.0,
                    "protein_g": 4.0,
                    "carbs_g": 27.0,
                    "fat_g": 7.0,
                }
            ],
        }

    monkeypatch.setattr("app.main.analyze_meal_photo", fake_analyze_coffee)
    coffee_resp = client.post(
        "/api/meals/analyze",
        headers=headers,
        files={"image": ("coffee.jpg", io.BytesIO(b"\xff\xd8\xff\xe0coffee"), "image/jpeg")},
        data={"description": "iced oat milk latte, 16 oz", "note": "1 pump vanilla"},
    )
    assert coffee_resp.status_code == 200
    assert captured_notes[0] == "iced oat milk latte, 16 oz; 1 pump vanilla"


def test_meals_crud_timezone_filtering_and_isolation(client: TestClient) -> None:
    user_a = _signup_user(client, email="usera@example.com", pin="1111")
    user_b = _signup_user(client, email="userb@example.com", pin="2222")
    headers_a = _auth_headers(user_a["access_token"])
    headers_b = _auth_headers(user_b["access_token"])

    # Create meal with default UTC timestamp and null notes (matches PWA empty-note payload)
    default_ts = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "Morning Shake",
            "source": "manual",
            "notes": None,
            "calories": 300,
            "protein_g": 35,
            "carbs_g": 20,
            "fat_g": 8,
        },
    )
    assert default_ts.status_code == 201
    assert default_ts.json()["notes"] == ""
    assert default_ts.json()["logged_at"].endswith(("Z", "+00:00"))
    assert client.delete(f"/api/meals/{default_ts.json()['id']}", headers=headers_a).status_code == 200

    # PST (tz_offset_minutes=480):
    # 4:00 PM PST on 2026-11-16 == 2026-11-17T00:00:00Z
    # 11:00 PM PST on 2026-11-16 == 2026-11-17T07:00:00Z
    # 12:05 AM PST on 2026-11-17 == 2026-11-17T08:05:00Z
    m_4pm = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "4PM Local Snack",
            "logged_at": "2026-11-17T00:00:00Z",
            "source": "photo",
            "detected_reference": "mug",
            "confidence": "high",
            "items": [
                {
                    "name": "Protein Oats",
                    "portion_description": "1 bowl",
                    "estimated_grams": 220,
                    "calories": 400,
                    "protein_g": 30,
                    "carbs_g": 50,
                    "fat_g": 8,
                }
            ],
        },
    )
    assert m_4pm.status_code == 201
    meal_4pm_id = m_4pm.json()["id"]
    assert m_4pm.json()["calories"] == 400.0  # derived from items

    m_11pm = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "11PM Local Snack",
            "logged_at": "2026-11-17T07:00:00Z",
            "source": "manual",
            "calories": 200,
            "protein_g": 20,
            "carbs_g": 15,
            "fat_g": 6,
        },
    )
    assert m_11pm.status_code == 201

    m_next_day = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "12:05AM Next Day Snack",
            "logged_at": "2026-11-17T08:05:00Z",
            "source": "manual",
            "calories": 150,
            "protein_g": 10,
            "carbs_g": 20,
            "fat_g": 3,
        },
    )
    assert m_next_day.status_code == 201

    # Query local day 2026-11-16 in PST (offset=480) -> should return 4PM + 11PM snacks ONLY
    nov16 = client.get("/api/meals?date=2026-11-16&tz_offset_minutes=480", headers=headers_a)
    assert nov16.status_code == 200
    names_nov16 = {m["meal_name"] for m in nov16.json()}
    assert names_nov16 == {"4PM Local Snack", "11PM Local Snack"}

    # Query local day 2026-11-17 in PST -> should include 12:05AM Next Day Snack
    nov17 = client.get("/api/meals?date=2026-11-17&tz_offset_minutes=480", headers=headers_a)
    assert "12:05AM Next Day Snack" in {m["meal_name"] for m in nov17.json()}

    # Explicit UTC start/end range
    ranged = client.get(
        "/api/meals?start=2026-11-17T06:00:00Z&end=2026-11-17T09:00:00Z",
        headers=headers_a,
    )
    assert {m["meal_name"] for m in ranged.json()} == {"11PM Local Snack", "12:05AM Next Day Snack"}

    # PATCH portion_multiplier on item-based meal scales both totals and items consistently
    patched = client.patch(
        f"/api/meals/{meal_4pm_id}",
        headers=headers_a,
        json={"portion_multiplier": 0.5, "notes": "Ate half"},
    )
    assert patched.status_code == 200
    assert patched.json()["calories"] == 200.0
    assert patched.json()["protein_g"] == 15.0
    assert patched.json()["items"][0]["calories"] == 200.0
    assert patched.json()["items"][0]["protein_g"] == 15.0
    assert patched.json()["notes"] == "Ate half"

    # Subsequent PATCH to 1.5x recovers exact 1.5x of original 1x macros without drift
    rescaled = client.patch(
        f"/api/meals/{meal_4pm_id}",
        headers=headers_a,
        json={"portion_multiplier": 1.5},
    )
    assert rescaled.status_code == 200
    assert rescaled.json()["calories"] == 600.0
    assert rescaled.json()["items"][0]["calories"] == 600.0

    # Frontend-style PATCH sending already-scaled items + calories + portion_multiplier does NOT double-scale
    no_double_scale = client.patch(
        f"/api/meals/{meal_4pm_id}",
        headers=headers_a,
        json={
            "portion_multiplier": 0.75,
            "items": [
                {
                    "name": "Protein Oats",
                    "portion_description": "1 bowl",
                    "estimated_grams": 165,
                    "calories": 300,
                    "protein_g": 22.5,
                    "carbs_g": 37.5,
                    "fat_g": 6,
                }
            ],
            "calories": 300,
            "protein_g": 22.5,
            "carbs_g": 37.5,
            "fat_g": 6,
        },
    )
    assert no_double_scale.status_code == 200
    assert no_double_scale.json()["calories"] == 300.0
    assert no_double_scale.json()["items"][0]["calories"] == 300.0

    # Cross-user isolation: User B cannot PATCH or DELETE User A's meal
    assert client.patch(f"/api/meals/{meal_4pm_id}", headers=headers_b, json={"meal_name": "Hacked"}).status_code == 404
    assert client.delete(f"/api/meals/{meal_4pm_id}", headers=headers_b).status_code == 404

    # Delete succeeds for owner
    deleted = client.delete(f"/api/meals/{meal_4pm_id}", headers=headers_a)
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "deleted", "id": meal_4pm_id}


def test_daily_dashboard_aggregation_and_statuses(client: TestClient) -> None:
    auth = _signup_user(client)
    headers = _auth_headers(auth["access_token"])

    # Override targets to crisp numbers for testing status transitions
    client.put(
        "/api/config",
        headers=headers,
        json={"targets": {"calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 65}},
    )

    # Empty day -> under / under / meeting_goals=False
    empty_dash = client.get("/api/dashboard/daily?date=2026-11-16&tz_offset_minutes=480", headers=headers)
    assert empty_dash.status_code == 200
    empty_body = empty_dash.json()
    assert empty_body["meal_count"] == 0
    assert empty_body["status"]["calories"] == "under"
    assert empty_body["status"]["protein"] == "under"
    assert empty_body["status"]["meeting_goals"] is False

    # Log 1950 kcal & 155g protein on 2026-11-16 PST (2026-11-17T02:00:00Z = 6 PM PST Nov 16)
    client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": "Dinner & Shake",
            "logged_at": "2026-11-17T02:00:00Z",
            "source": "manual",
            "calories": 1950,
            "protein_g": 155,
            "carbs_g": 180,
            "fat_g": 60,
        },
    )
    on_track = client.get("/api/dashboard/daily?date=2026-11-16&tz_offset_minutes=480", headers=headers).json()
    assert on_track["meal_count"] == 1
    assert on_track["consumed"] == {"calories": 1950.0, "protein_g": 155.0, "carbs_g": 180.0, "fat_g": 60.0}
    assert on_track["remaining"] == {"calories": 50.0, "protein_g": -5.0, "carbs_g": 20.0, "fat_g": 5.0}
    assert on_track["status"]["calories"] == "on_track"
    assert on_track["status"]["protein"] == "met"
    assert on_track["status"]["meeting_goals"] is True

    # Add 400 kcal & 40g protein -> 2350 kcal (over), 195g protein (exceeded > 120% of 150)
    client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": "Late Dessert",
            "logged_at": "2026-11-17T06:30:00Z",  # 10:30 PM PST Nov 16
            "source": "manual",
            "calories": 400,
            "protein_g": 40,
            "carbs_g": 45,
            "fat_g": 10,
        },
    )
    over = client.get("/api/dashboard/daily?date=2026-11-16&tz_offset_minutes=480", headers=headers).json()
    assert over["meal_count"] == 2
    assert over["status"]["calories"] == "over"
    assert over["status"]["protein"] == "exceeded"
    assert over["status"]["meeting_goals"] is False


def test_init_db_adds_missing_photo_columns(tmp_path: Path) -> None:
    legacy_db = tmp_path / "legacy.db"
    legacy_engine = create_db_engine(f"sqlite:///{legacy_db}")
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE meal_entries (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    meal_name VARCHAR(255) NOT NULL,
                    logged_at DATETIME NOT NULL,
                    source VARCHAR(20) NOT NULL,
                    notes TEXT NOT NULL,
                    portion_multiplier FLOAT NOT NULL,
                    items JSON NOT NULL,
                    calories FLOAT NOT NULL,
                    protein_g FLOAT NOT NULL,
                    carbs_g FLOAT NOT NULL,
                    fat_g FLOAT NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )

    init_db(legacy_engine)
    cols = {col["name"] for col in inspect(legacy_engine).get_columns("meal_entries")}
    assert "photo_data" in cols
    assert "photo_mime_type" in cols
    legacy_engine.dispose()


def test_meal_photo_upload_download_and_auth_isolation(client: TestClient) -> None:
    user_a = _signup_user(client, email="photo_a@example.com", pin="1234")
    headers_a = _auth_headers(user_a["access_token"])

    created = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "Steak & Potatoes",
            "source": "photo",
            "calories": 650,
            "protein_g": 48,
            "carbs_g": 45,
            "fat_g": 28,
        },
    ).json()
    meal_id = created["id"]
    assert created["has_photo"] is False
    assert created["photo_url"] is None

    # No photo uploaded yet -> 404
    assert client.get(f"/api/meals/{meal_id}/photo", headers=headers_a).status_code == 404

    # Non-image file rejected with 400
    bad_upload = client.post(
        f"/api/meals/{meal_id}/photo",
        headers=headers_a,
        files={"image": ("bad.txt", io.BytesIO(b"not-an-image"), "text/plain")},
    )
    assert bad_upload.status_code == 400

    # >8 MiB upload rejected with 413
    oversized = b"\xff\xd8\xff\xe0" + (b"\x00" * (8 * 1024 * 1024 + 10))
    big_upload = client.post(
        f"/api/meals/{meal_id}/photo",
        headers=headers_a,
        files={"image": ("huge.jpg", io.BytesIO(oversized), "image/jpeg")},
    )
    assert big_upload.status_code == 413

    # Valid PNG upload succeeds and populates has_photo + photo_url
    from PIL import Image
    image_buffer = io.BytesIO()
    Image.new("RGB", (64, 48), "red").save(image_buffer, format="PNG")
    png_bytes = image_buffer.getvalue()
    up = client.post(
        f"/api/meals/{meal_id}/photo",
        headers=headers_a,
        files={"image": ("meal.png", io.BytesIO(png_bytes), "image/png")},
    )
    assert up.status_code == 200
    up_body = up.json()
    assert up_body["has_photo"] is True
    assert up_body["photo_url"] == f"/api/meals/{meal_id}/photo"

    # Cookie auth works directly for <img> tag fetches without Authorization header
    img_cookie = client.get(f"/api/meals/{meal_id}/photo")
    assert img_cookie.status_code == 200
    assert Image.open(io.BytesIO(img_cookie.content)).format == "JPEG"
    assert img_cookie.headers["content-type"].startswith("image/jpeg")
    assert img_cookie.headers["cache-control"] == "private, no-store"

    # Bearer auth works too
    client.cookies.clear()
    img_bearer = client.get(f"/api/meals/{meal_id}/photo", headers=headers_a)
    assert img_bearer.status_code == 200
    assert img_bearer.content == img_cookie.content

    # Cross-user isolation: User B gets 404 for GET and POST photo
    user_b = _signup_user(client, email="photo_b@example.com", pin="5678")
    headers_b = _auth_headers(user_b["access_token"])
    assert client.get(f"/api/meals/{meal_id}/photo", headers=headers_b).status_code == 404
    assert (
        client.post(
            f"/api/meals/{meal_id}/photo",
            headers=headers_b,
            files={"image": ("meal.png", io.BytesIO(png_bytes), "image/png")},
        ).status_code
        == 404
    )


def test_meal_logs_pagination_search_and_date_filter(client: TestClient) -> None:
    auth = _signup_user(client, email="logs@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    meals_seed = [
        ("Oatmeal Bowl", "2026-11-15T15:00:00Z", "with whey scoop"),
        ("Chicken Salad", "2026-11-16T19:00:00Z", "light ranch dressing"),
        ("Protein Shake", "2026-11-17T01:00:00Z", "post workout shake"),
        ("Turkey Sandwich", "2026-11-17T03:00:00Z", "whole wheat bread"),
        ("Greek Yogurt", "2026-11-17T06:00:00Z", "honey and berries"),
    ]
    for name, ts, note in meals_seed:
        resp = client.post(
            "/api/meals",
            headers=headers,
            json={
                "meal_name": name,
                "logged_at": ts,
                "source": "manual",
                "notes": note,
                "calories": 350,
                "protein_g": 28,
                "carbs_g": 35,
                "fat_g": 10,
            },
        )
        assert resp.status_code == 201

    # Page 1 of 2-item pages (ordered newest first)
    p1 = client.get("/api/meals/logs?page=1&page_size=2", headers=headers).json()
    assert p1["total"] == 5
    assert p1["page"] == 1
    assert p1["page_size"] == 2
    assert p1["total_pages"] == 3
    assert p1["has_next"] is True
    assert p1["has_prev"] is False
    assert [m["meal_name"] for m in p1["items"]] == ["Greek Yogurt", "Turkey Sandwich"]

    p2 = client.get("/api/meals/logs?page=2&page_size=2", headers=headers).json()
    assert p2["has_next"] is True
    assert p2["has_prev"] is True
    assert [m["meal_name"] for m in p2["items"]] == ["Protein Shake", "Chicken Salad"]

    p3 = client.get("/api/meals/logs?page=3&page_size=2", headers=headers).json()
    assert p3["has_next"] is False
    assert p3["has_prev"] is True
    assert [m["meal_name"] for m in p3["items"]] == ["Oatmeal Bowl"]

    # Case-insensitive q matches both meal_name ("Protein Shake") and notes ("whey" -> Oatmeal Bowl)
    search_shake = client.get("/api/meals/logs?q=SHAKE", headers=headers).json()
    assert search_shake["total"] == 1
    assert search_shake["items"][0]["meal_name"] == "Protein Shake"

    search_whey = client.get("/api/meals/logs?q=WHEY", headers=headers).json()
    assert search_whey["total"] == 1
    assert search_whey["items"][0]["meal_name"] == "Oatmeal Bowl"

    # Local date filter in PST (tz_offset_minutes=480):
    # 2026-11-16 PST = [2026-11-16T08:00:00Z, 2026-11-17T08:00:00Z) -> 4 meals (excludes Nov 15 15:00Z)
    nov16_logs = client.get("/api/meals/logs?date=2026-11-16&tz_offset_minutes=480", headers=headers).json()
    assert nov16_logs["total"] == 4
    assert "Oatmeal Bowl" not in {m["meal_name"] for m in nov16_logs["items"]}

    # Empty date string acts as unfiltered
    unfiltered = client.get("/api/meals/logs?date=", headers=headers).json()
    assert unfiltered["total"] == 5


def test_dashboard_history_aggregation_and_streaks(client: TestClient) -> None:
    auth = _signup_user(client, email="history@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    client.put(
        "/api/config",
        headers=headers,
        json={"targets": {"calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 65}},
    )

    # PST (tz_offset_minutes=480):
    # 2026-11-12: under calories (1200) & under protein (80) -> breaks earlier streak
    # 2026-11-13: on_track (1950) & met (155) -> goal met
    # 2026-11-14: on_track (2000) & met (150) -> goal met
    # 2026-11-15: on_track (2050) & met (160) -> goal met
    # 2026-11-16: no meals yet -> should NOT break the 3-day streak ending 2026-11-15!
    day_meals = [
        ("2026-11-12T20:00:00Z", 1200, 80),
        ("2026-11-13T20:00:00Z", 1950, 155),
        ("2026-11-14T20:00:00Z", 2000, 150),
        ("2026-11-15T20:00:00Z", 2050, 160),
    ]
    for ts, cal, pro in day_meals:
        resp = client.post(
            "/api/meals",
            headers=headers,
            json={
                "meal_name": f"Meal {ts}",
                "logged_at": ts,
                "source": "manual",
                "calories": cal,
                "protein_g": pro,
                "carbs_g": 180,
                "fat_g": 60,
            },
        )
        assert resp.status_code == 201

    hist = client.get(
        "/api/dashboard/history?days=5&end_date=2026-11-16&tz_offset_minutes=480",
        headers=headers,
    )
    assert hist.status_code == 200
    data = hist.json()
    assert data["days"] == 5
    assert [d["date"] for d in data["series"]] == [
        "2026-11-12",
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
        "2026-11-16",
    ]
    assert data["summary"]["days_logged"] == 4
    assert data["summary"]["days_calories_met"] == 3
    assert data["summary"]["days_protein_met"] == 3
    assert data["summary"]["days_both_met"] == 3
    assert data["summary"]["current_streak"] == 3
    assert data["summary"]["avg_calories"] == 1800.0
    assert data["summary"]["avg_protein_g"] == 136.2  # (80+155+150+160)/4 = 136.25 -> 136.2

    # Logging an over-calorie meal on end_date (2026-11-16 PST = 2026-11-17T02:00:00Z) resets streak to 0
    client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": "Feast",
            "logged_at": "2026-11-17T02:00:00Z",
            "source": "manual",
            "calories": 2600,
            "protein_g": 160,
            "carbs_g": 280,
            "fat_g": 90,
        },
    )
    hist_after = client.get(
        "/api/dashboard/history?days=5&end_date=2026-11-16&tz_offset_minutes=480",
        headers=headers,
    ).json()
    assert hist_after["summary"]["days_logged"] == 5
    assert hist_after["summary"]["days_calories_met"] == 3
    assert hist_after["summary"]["days_protein_met"] == 4
    assert hist_after["summary"]["days_both_met"] == 3
    assert hist_after["summary"]["current_streak"] == 0


def test_analyze_meal_text_and_previous_day_backfill(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth = _signup_user(client, email="textlog@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    # Empty / whitespace description rejected with 422
    assert client.post("/api/meals/analyze-text", headers=headers, json={"description": "   "}).status_code == 422

    # Missing API key returns 503
    no_key = client.post(
        "/api/meals/analyze-text",
        headers=headers,
        json={"description": "3 scrambled eggs and 2 slices sourdough toast with butter"},
    )
    assert no_key.status_code == 503
    assert "GEMINI_API_KEY" in no_key.json()["detail"]

    # Mocked Gemini text analysis
    def fake_analyze_text(*, description: str, **_: Any):
        assert "3 scrambled eggs" in description
        return {
            "meal_name": "Scrambled Eggs & Sourdough Toast",
            "detected_reference": None,
            "confidence": "medium",
            "notes": "Assumed 1 tsp butter for cooking eggs and 1 tbsp butter on toast.",
            "total": {"calories": 540.0, "protein_g": 26.0, "carbs_g": 42.0, "fat_g": 28.0},
            "items": [
                {
                    "name": "3 scrambled eggs",
                    "portion_description": "3 large eggs cooked in butter",
                    "estimated_grams": 160.0,
                    "calories": 260.0,
                    "protein_g": 19.0,
                    "carbs_g": 2.0,
                    "fat_g": 19.0,
                },
                {
                    "name": "2 slices sourdough toast",
                    "portion_description": "2 medium slices with butter",
                    "estimated_grams": 100.0,
                    "calories": 280.0,
                    "protein_g": 7.0,
                    "carbs_g": 40.0,
                    "fat_g": 9.0,
                },
            ],
        }

    monkeypatch.setattr("app.main.analyze_meal_text", fake_analyze_text)
    analyzed = client.post(
        "/api/meals/analyze-text",
        headers=headers,
        json={"description": "3 scrambled eggs and 2 slices sourdough toast with butter"},
    )
    assert analyzed.status_code == 200
    body = analyzed.json()
    assert body["detected_reference"] is None
    assert body["total"]["calories"] == 540.0
    assert len(body["items"]) == 2

    # Backfill forgotten meal on yesterday's local calendar date (2026-11-15 8:30 AM PST == 2026-11-15T16:30:00Z)
    saved = client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": body["meal_name"],
            "logged_at": "2026-11-15T16:30:00Z",
            "source": "text",
            "confidence": body["confidence"],
            "notes": body["notes"],
            "portion_multiplier": 1.0,
            "items": body["items"],
            "calories": body["total"]["calories"],
            "protein_g": body["total"]["protein_g"],
            "carbs_g": body["total"]["carbs_g"],
            "fat_g": body["total"]["fat_g"],
        },
    )
    assert saved.status_code == 201
    assert saved.json()["source"] == "text"

    # Verify it appears in yesterday's daily dashboard, paginated logs, and multi-day history
    dash_yest = client.get("/api/dashboard/daily?date=2026-11-15&tz_offset_minutes=480", headers=headers).json()
    assert dash_yest["meal_count"] == 1
    assert dash_yest["consumed"]["calories"] == 540.0

    logs_yest = client.get("/api/meals/logs?date=2026-11-15&tz_offset_minutes=480", headers=headers).json()
    assert logs_yest["total"] == 1
    assert logs_yest["items"][0]["source"] == "text"

    hist = client.get("/api/dashboard/history?days=2&end_date=2026-11-16&tz_offset_minutes=480", headers=headers).json()
    assert hist["series"][0]["date"] == "2026-11-15"
    assert hist["series"][0]["calories"] == 540.0
    assert hist["series"][1]["date"] == "2026-11-16"
    assert hist["series"][1]["calories"] == 0.0


def test_refine_meal_from_text(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_a = _signup_user(client, email="refine_a@example.com", pin="1234")
    headers_a = _auth_headers(user_a["access_token"])

    created = client.post(
        "/api/meals",
        headers=headers_a,
        json={
            "meal_name": "Eggs & Oats",
            "source": "photo",
            "detected_reference": "dinner fork",
            "confidence": "high",
            "notes": "3 large eggs + oats",
            "items": [
                {
                    "name": "3 scrambled eggs",
                    "portion_description": "3 large eggs",
                    "estimated_grams": 150.0,
                    "calories": 216.0,
                    "protein_g": 18.9,
                    "carbs_g": 1.6,
                    "fat_g": 14.4,
                },
                {
                    "name": "1 bowl oatmeal",
                    "portion_description": "1 cup cooked oats",
                    "estimated_grams": 234.0,
                    "calories": 150.0,
                    "protein_g": 5.0,
                    "carbs_g": 27.0,
                    "fat_g": 3.0,
                },
            ],
        },
    ).json()
    meal_id = created["id"]

    # Blank instruction rejected with 422
    assert client.post(f"/api/meals/{meal_id}/refine", headers=headers_a, json={"instruction": " "}).status_code == 422

    # Missing API key returns 503
    assert (
        client.post(
            f"/api/meals/{meal_id}/refine",
            headers=headers_a,
            json={"instruction": "actually had 2 eggs instead of 3"},
        ).status_code
        == 503
    )

    # Cross-user isolation -> 404
    user_b = _signup_user(client, email="refine_b@example.com", pin="5678")
    assert (
        client.post(
            f"/api/meals/{meal_id}/refine",
            headers=_auth_headers(user_b["access_token"]),
            json={"instruction": "actually had 2 eggs"},
        ).status_code
        == 404
    )

    def fake_refine(*, meal_name: str, current_items: list[dict[str, Any]], instruction: str, **_: Any):
        assert meal_name == "Eggs & Oats"
        assert len(current_items) == 2
        assert "2 eggs" in instruction
        return {
            "meal_name": "Eggs & Oats",
            "detected_reference": None,
            "confidence": "high",
            "notes": "Updated eggs from 3 to 2 per user instruction.",
            "total": {"calories": 294.0, "protein_g": 17.6, "carbs_g": 28.1, "fat_g": 12.6},
            "items": [
                {
                    "name": "2 scrambled eggs",
                    "portion_description": "2 large eggs",
                    "estimated_grams": 100.0,
                    "calories": 144.0,
                    "protein_g": 12.6,
                    "carbs_g": 1.1,
                    "fat_g": 9.6,
                },
                {
                    "name": "1 bowl oatmeal",
                    "portion_description": "1 cup cooked oats",
                    "estimated_grams": 234.0,
                    "calories": 150.0,
                    "protein_g": 5.0,
                    "carbs_g": 27.0,
                    "fat_g": 3.0,
                },
            ],
        }

    monkeypatch.setattr("app.main.refine_meal_from_text", fake_refine)
    refined = client.post(
        f"/api/meals/{meal_id}/refine",
        headers=headers_a,
        json={"instruction": "actually had 2 eggs instead of 3"},
    )
    assert refined.status_code == 200
    refined_body = refined.json()
    assert refined_body["detected_reference"] == "dinner fork"  # preserved from existing meal
    assert refined_body["total"]["calories"] == 294.0
    assert refined_body["items"][0]["name"] == "2 scrambled eggs"

    # Frontend applies refined items via PATCH /api/meals/{meal_id}
    patched = client.patch(
        f"/api/meals/{meal_id}",
        headers=headers_a,
        json={
            "meal_name": refined_body["meal_name"],
            "notes": refined_body["notes"],
            "items": refined_body["items"],
            "calories": refined_body["total"]["calories"],
            "protein_g": refined_body["total"]["protein_g"],
            "carbs_g": refined_body["total"]["carbs_g"],
            "fat_g": refined_body["total"]["fat_g"],
        },
    )
    assert patched.status_code == 200
    assert patched.json()["calories"] == 294.0


def test_init_db_adds_missing_user_notification_columns(tmp_path: Path) -> None:
    legacy_db = tmp_path / "legacy_users.db"
    legacy_engine = create_db_engine(f"sqlite:///{legacy_db}")
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    name VARCHAR(120) NOT NULL,
                    pin_hash VARCHAR(255) NOT NULL,
                    height_cm FLOAT NOT NULL,
                    weight_kg FLOAT NOT NULL,
                    age INTEGER NOT NULL,
                    sex VARCHAR(20) NOT NULL,
                    activity_level VARCHAR(32) NOT NULL,
                    goal VARCHAR(32) NOT NULL,
                    target_calories FLOAT NOT NULL,
                    target_protein_g FLOAT NOT NULL,
                    target_carbs_g FLOAT NOT NULL,
                    target_fat_g FLOAT NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )

    init_db(legacy_engine)
    cols = {col["name"] for col in inspect(legacy_engine).get_columns("users")}
    for expected_col in (
        "notifications_enabled",
        "breakfast_time",
        "lunch_time",
        "dinner_time",
        "reminder_timezone",
        "last_breakfast_sent_date",
        "last_lunch_sent_date",
        "last_dinner_sent_date",
    ):
        assert expected_col in cols
    assert "push_subscriptions" in inspect(legacy_engine).get_table_names()
    legacy_engine.dispose()


def test_vapid_key_generation_and_persistence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "")
    keys_path = tmp_path / "vapid.json"

    pub1, priv1 = notification_service.get_or_create_vapid_keys(keys_file=keys_path)
    assert len(pub1) == 87  # 65-byte uncompressed P-256 point in unpadded base64url
    assert pub1.startswith("B")
    assert len(priv1) > 40
    assert keys_path.exists()

    # Subsequent calls reuse the persisted keypair
    pub2, priv2 = notification_service.get_or_create_vapid_keys(keys_file=keys_path)
    assert (pub2, priv2) == (pub1, priv1)


def test_notification_config_subscribe_test_and_unsubscribe(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth = _signup_user(client, email="push@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    vapid_resp = client.get("/api/notifications/vapid-public-key")
    assert vapid_resp.status_code == 200
    assert vapid_resp.json()["configured"] is True
    assert vapid_resp.json()["public_key"].startswith("B")

    # Initial config has notifications disabled with default 3/day schedule
    cfg = client.get("/api/config", headers=headers).json()
    assert cfg["notifications"] == {
        "enabled": False,
        "breakfast_time": "08:30",
        "lunch_time": "13:00",
        "dinner_time": "19:30",
        "timezone": "UTC",
        "active_subscriptions": 0,
    }

    # Invalid HH:MM or timezone rejected with 422
    assert (
        client.put(
            "/api/config",
            headers=headers,
            json={"notifications": {"breakfast_time": "25:99"}},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/config",
            headers=headers,
            json={"notifications": {"timezone": "Mars/Olympus_Mons"}},
        ).status_code
        == 422
    )

    # Valid schedule update persists
    updated_cfg = client.put(
        "/api/config",
        headers=headers,
        json={
            "notifications": {
                "breakfast_time": "07:45",
                "lunch_time": "12:15",
                "dinner_time": "18:45",
                "timezone": "America/Los_Angeles",
            }
        },
    )
    assert updated_cfg.status_code == 200
    assert updated_cfg.json()["notifications"]["breakfast_time"] == "07:45"
    assert updated_cfg.json()["notifications"]["timezone"] == "America/Los_Angeles"

    # Subscribe device
    sub_resp = client.post(
        "/api/notifications/subscribe",
        headers=headers,
        json={
            "endpoint": "https://push.example.com/sub/device-1",
            "keys": {"p256dh": "test-p256dh-key", "auth": "test-auth-secret"},
            "timezone": "America/New_York",
            "user_agent": "pytest-pwa",
        },
    )
    assert sub_resp.status_code == 200
    assert sub_resp.json()["enabled"] is True
    assert sub_resp.json()["active_subscriptions"] == 1
    assert sub_resp.json()["timezone"] == "America/New_York"

    # Test push endpoint dispatches via mocked webpush
    sent_payloads: list[dict[str, Any]] = []

    def fake_webpush(*, subscription_info, data, vapid_private_key, vapid_claims):
        sent_payloads.append(
            {
                "endpoint": subscription_info["endpoint"],
                "data": json.loads(data),
                "priv": vapid_private_key,
                "claims": vapid_claims,
            }
        )

    monkeypatch.setattr(notification_service, "webpush", fake_webpush)
    test_push = client.post("/api/notifications/test", headers=headers)
    assert test_push.status_code == 200
    assert test_push.json()["sent"] == 1
    assert test_push.json()["failed"] == 0
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["data"]["url"] == "/?action=snap"

    # Unsubscribe removes device and turns notifications_enabled back to False
    unsub = client.request(
        "DELETE",
        "/api/notifications/subscribe",
        headers=headers,
        json={"endpoint": "https://push.example.com/sub/device-1"},
    )
    assert unsub.status_code == 200
    assert unsub.json()["active_subscriptions"] == 0
    assert unsub.json()["enabled"] is False


def test_dispatch_due_reminders_three_per_day_no_duplicates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "reminders.db"
    test_engine = create_db_engine(f"sqlite:///{db_path}")
    TestingSession = sessionmaker(
        bind=test_engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
        class_=Session,
    )
    init_db(test_engine)

    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "BTestPublicKey")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "TestPrivateKey")

    sent_events: list[dict[str, Any]] = []

    def fake_webpush(*, subscription_info, data, vapid_private_key, vapid_claims):
        sent_events.append(json.loads(data))

    monkeypatch.setattr(notification_service, "webpush", fake_webpush)

    with TestingSession() as db:
        user = User(
            email="sched@example.com",
            name="Sched",
            pin_hash=hash_pin("1234"),
            height_cm=175.0,
            weight_kg=70.0,
            age=28,
            sex="male",
            activity_level="moderate",
            goal="maintain",
            target_calories=2200.0,
            target_protein_g=150.0,
            target_carbs_g=240.0,
            target_fat_g=66.0,
            notifications_enabled=True,
            breakfast_time="08:30",
            lunch_time="13:00",
            dinner_time="19:30",
            reminder_timezone="America/Los_Angeles",
        )
        db.add(user)
        db.flush()
        db.add(
            PushSubscription(
                user_id=user.id,
                endpoint="https://push.example.com/sub/sched-1",
                p256dh="p256dh-val",
                auth="auth-val",
            )
        )
        db.commit()

        # In November 2026, PST is UTC-8:
        # 08:35 PST on 2026-11-16 == 16:35 UTC -> Breakfast due
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 16, 16, 35, tzinfo=timezone.utc)) == 1
        assert "Breakfast" in sent_events[-1]["title"]
        assert "2200 kcal" in sent_events[-1]["body"]

        # Same window 5 mins later (08:40 PST) -> deduplicated, 0 sent
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 16, 16, 40, tzinfo=timezone.utc)) == 0

        # 13:05 PST on 2026-11-16 == 21:05 UTC -> Lunch due
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 16, 21, 5, tzinfo=timezone.utc)) == 1
        assert "Lunch" in sent_events[-1]["title"]

        # 19:35 PST on 2026-11-16 == 2026-11-17 03:35 UTC -> Dinner due on same local day (2026-11-16)
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 17, 3, 35, tzinfo=timezone.utc)) == 1
        assert "Dinner" in sent_events[-1]["title"]

        # 19:40 PST -> deduplicated, 0 sent
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 17, 3, 40, tzinfo=timezone.utc)) == 0

        # Next day 08:32 PST (2026-11-17 16:32 UTC) -> Breakfast fires again for new local day
        assert notification_service.dispatch_due_reminders(db, datetime(2026, 11, 17, 16, 32, tzinfo=timezone.utc)) == 1
        assert len(sent_events) == 4

    test_engine.dispose()


def test_transcribe_meal_audio_endpoint_and_mime_detection(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Audio MIME normalization handles MediaRecorder formats + rejects images/text
    assert gemini_service.detect_audio_mime_type(b"\x1a\x45\xdf\xa3webm") == "audio/webm"
    assert gemini_service.detect_audio_mime_type(b"\x00\x00\x00\x20ftypM4A ", "video/mp4") == "audio/mp4"
    assert gemini_service.detect_audio_mime_type(b"data", "audio/webm;codecs=opus") == "audio/webm"
    assert gemini_service.detect_audio_mime_type(b"data", "audio/m4a") == "audio/mp4"
    assert gemini_service.detect_audio_mime_type(b"\xff\xd8\xff\xe0jpeg", "audio/mp4") is None
    assert gemini_service.detect_audio_mime_type(b"hello", "text/plain") is None

    auth = _signup_user(client, email="voice@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    # Missing API key returns 503
    no_key = client.post(
        "/api/meals/transcribe",
        headers=headers,
        files={"audio": ("clip.webm", io.BytesIO(b"\x1a\x45\xdf\xa3fakewebm"), "audio/webm;codecs=opus")},
    )
    assert no_key.status_code == 503
    assert "GEMINI_API_KEY" in no_key.json()["detail"]

    # Unsupported file returns 400
    bad_audio = client.post(
        "/api/meals/transcribe",
        headers=headers,
        files={"audio": ("note.txt", io.BytesIO(b"plain text"), "text/plain")},
    )
    assert bad_audio.status_code == 400

    # Oversized (>10 MiB) returns 413
    too_big = client.post(
        "/api/meals/transcribe",
        headers=headers,
        files={"audio": ("huge.webm", io.BytesIO(b"\x1a\x45\xdf\xa3" + b"\x00" * (10 * 1024 * 1024 + 5)), "audio/webm")},
    )
    assert too_big.status_code == 413

    # Mocked Gemini REST fallback verifies audio inlineData + transcript extraction for webm & mp4
    seen_mimes: list[str] = []

    class FakeHttpResponse:
        def __init__(self, body: dict[str, Any]) -> None:
            self._raw = json.dumps(body).encode("utf-8")

        def read(self) -> bytes:
            return self._raw

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(req, timeout=0):
        payload = json.loads(req.data.decode("utf-8"))
        parts = payload["contents"][0]["parts"]
        seen_mimes.append(parts[1]["inlineData"]["mimeType"])
        return FakeHttpResponse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {"transcript": "Iced oat milk latte with one pump of vanilla"}
                                    )
                                }
                            ]
                        }
                    }
                ]
            }
        )

    monkeypatch.setattr(gemini_service, "genai", None)
    monkeypatch.setattr(gemini_service, "types", None)
    monkeypatch.setattr(gemini_service.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("GEMINI_API_KEY", "test-voice-key")

    r_webm = client.post(
        "/api/meals/transcribe",
        headers=headers,
        files={"audio": ("voice.webm", io.BytesIO(b"\x1a\x45\xdf\xa3webmdata"), "audio/webm;codecs=opus")},
    )
    assert r_webm.status_code == 200
    assert r_webm.json() == {"transcript": "Iced oat milk latte with one pump of vanilla"}

    r_mp4 = client.post(
        "/api/meals/transcribe",
        headers=headers,
        files={"audio": ("voice.m4a", io.BytesIO(b"\x00\x00\x00\x20ftypM4A audio"), "audio/mp4")},
    )
    assert r_mp4.status_code == 200
    assert r_mp4.json() == {"transcript": "Iced oat milk latte with one pump of vanilla"}
    assert seen_mimes == ["audio/webm", "audio/mp4"]


def test_named_timezone_day_boundaries_and_historical_edit(client: TestClient) -> None:
    user = _signup_user(client, email="calendar@example.com")
    headers = _auth_headers(user["access_token"])
    # Los Angeles spring-forward day: 23 hours, bounded by 08:00Z and 07:00Z.
    examples = [
        ("before", "2026-03-08T07:59:00Z"),
        ("first", "2026-03-08T08:00:00Z"),
        ("last", "2026-03-09T06:59:00Z"),
        ("after", "2026-03-09T07:00:00Z"),
    ]
    ids = {}
    for name, stamp in examples:
        response = client.post('/api/meals', headers=headers, json={"meal_name": name, "logged_at": stamp, "calories": 100, "protein_g": 10})
        assert response.status_code == 201
        ids[name] = response.json()['id']
    params = {"date": "2026-03-08", "tz_name": "America/Los_Angeles", "tz_offset_minutes": 480}
    logs = client.get('/api/meals/logs', headers=headers, params=params)
    assert {m['meal_name'] for m in logs.json()['items']} == {'first', 'last'}
    dash = client.get('/api/dashboard/daily', headers=headers, params=params).json()
    assert dash['meal_count'] == 2 and dash['consumed']['calories'] == 200
    changed = client.patch(f"/api/meals/{ids['last']}", headers=headers, json={'meal_name': 'edited', 'calories': 150})
    assert changed.status_code == 200 and changed.json()['logged_at'].startswith('2026-03-09T06:59')
    assert client.get('/api/dashboard/daily', headers=headers, params=params).json()['consumed']['calories'] == 250
    next_day = client.get('/api/meals/logs', headers=headers, params={**params, 'date': '2026-03-09'}).json()
    assert [m['meal_name'] for m in next_day['items']] == ['after']
    empty = client.get('/api/meals/logs', headers=headers, params={**params, 'date': '2026-03-10'}).json()
    assert empty['total'] == 0
    assert client.get('/api/dashboard/daily', headers=headers, params={**params, 'tz_name': 'Invalid/Zone'}).status_code == 422


def test_named_timezone_fall_back_day_and_history(client: TestClient) -> None:
    user = _signup_user(client, email='fallback@example.com')
    headers = _auth_headers(user['access_token'])
    for stamp in ['2026-11-01T07:00:00Z', '2026-11-02T07:59:00Z', '2026-11-02T08:00:00Z']:
        assert client.post('/api/meals', headers=headers, json={'meal_name': stamp, 'logged_at': stamp, 'calories': 100}).status_code == 201
    params = {'date': '2026-11-01', 'tz_name': 'America/Los_Angeles'}
    assert client.get('/api/meals/logs', headers=headers, params=params).json()['total'] == 2
    history = client.get('/api/dashboard/history', headers=headers, params={'end_date': '2026-11-02', 'days': 2, 'tz_name': 'America/Los_Angeles'}).json()
    assert [day['meal_count'] for day in history['series']] == [2, 1]


def test_photo_save_is_atomic_retry_safe_and_strips_metadata(client: TestClient) -> None:
    import uuid
    from PIL import Image
    user = _signup_user(client, email='atomic@example.com')
    headers = _auth_headers(user['access_token'])
    request_id = str(uuid.uuid4())
    payload = json.dumps({'meal_name': 'Photo test', 'source': 'photo', 'calories': 345, 'protein_g': 25})
    bad = client.post('/api/meals/with-photo', headers=headers, data={'payload': payload, 'request_id': request_id}, files={'image': ('bad.jpg', b'\xff\xd8\xffinvalid', 'image/jpeg')})
    assert bad.status_code == 400
    assert client.get('/api/meals/logs', headers=headers, params={'q': 'Photo test'}).json()['total'] == 0
    photo = Image.new('RGB', (2200, 1200), 'red')
    exif = Image.Exif(); exif[274] = 6; exif[315] = 'private metadata'
    buf = io.BytesIO(); photo.save(buf, format='JPEG', exif=exif)
    def save():
        return client.post('/api/meals/with-photo', headers=headers, data={'payload': payload, 'request_id': request_id}, files={'image': ('photo.jpg', buf.getvalue(), 'image/jpeg')})
    first = save(); assert first.status_code == 201, first.text
    second = save(); assert second.status_code == 201 and second.json()['id'] == first.json()['id']
    assert client.get('/api/meals/logs', headers=headers, params={'q': 'Photo test'}).json()['total'] == 1
    downloaded = client.get(first.json()['photo_url'], headers=headers)
    assert downloaded.status_code == 200 and downloaded.headers['content-type'] == 'image/jpeg'
    assert len(downloaded.content) <= 1_000_000
    decoded = Image.open(io.BytesIO(downloaded.content)); decoded.load()
    assert decoded.height > decoded.width and max(decoded.size) <= 1600
    assert len(decoded.getexif()) == 0
    changed = client.post('/api/meals/with-photo', headers=headers, data={'payload': json.dumps({'meal_name': 'Other', 'source': 'photo', 'calories': 100}), 'request_id': request_id}, files={'image': ('photo.jpg', buf.getvalue(), 'image/jpeg')})
    assert changed.status_code == 409


def test_photo_compression_supports_legacy_formats() -> None:
    from PIL import Image
    from pillow_heif import register_heif_opener
    from app.photo_processing import compress_photo
    register_heif_opener()
    for fmt in ('JPEG', 'PNG', 'GIF', 'WEBP', 'HEIF'):
        buf = io.BytesIO()
        Image.new('RGB', (2100, 700), 'blue').save(buf, format=fmt)
        result = compress_photo(buf.getvalue())
        decoded = Image.open(io.BytesIO(result)); decoded.load()
        assert decoded.format == 'JPEG' and max(decoded.size) <= 1600 and len(result) <= 1_000_000


def test_apple_shortcuts_health_sync_bridge(client: TestClient) -> None:
    auth = _signup_user(client, email="shortcut@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])

    # Initially unconfigured
    status_res = client.get("/api/shortcuts/token", headers=headers)
    assert status_res.status_code == 200
    assert status_res.json() == {"configured": False, "token": None}

    # Generate personal shortcut token
    gen_res = client.post("/api/shortcuts/token", headers=headers)
    assert gen_res.status_code == 200
    shortcut_token = gen_res.json()["token"]
    assert shortcut_token.startswith("mls_")
    assert client.get("/api/shortcuts/token", headers=headers).json() == {
        "configured": True,
        "token": shortcut_token,
    }

    # Log 2 meals on 2026-11-16
    m1 = client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": "Morning Eggs",
            "logged_at": "2026-11-16T16:00:00Z",
            "calories": 280,
            "protein_g": 22,
            "carbs_g": 4,
            "fat_g": 18,
        },
    )
    assert m1.status_code == 201
    m2 = client.post(
        "/api/meals",
        headers=headers,
        json={
            "meal_name": "Protein Bar",
            "logged_at": "2026-11-16T21:00:00Z",
            "calories": 210,
            "protein_g": 20,
            "carbs_g": 22,
            "fat_g": 7,
        },
    )
    assert m2.status_code == 201

    # Sync via Bearer mls_ token with mark_synced=true
    sync_1 = client.get(
        "/api/shortcuts/health-sync",
        headers={"Authorization": f"Bearer {shortcut_token}"},
        params={"date": "2026-11-16", "tz_offset_minutes": 0, "unsynced_only": "true"},
    )
    assert sync_1.status_code == 200
    body_1 = sync_1.json()
    assert body_1["meal_count"] == 2
    assert body_1["unsynced_count"] == 2
    assert body_1["total_calories"] == 490
    assert body_1["total_protein_g"] == 42

    # A UTC meal near midnight retains its actual Los Angeles calendar day.
    pacific = client.get(
        "/api/shortcuts/health-sync",
        params={"token": shortcut_token, "date": "2026-11-16", "tz_offset_minutes": 480},
    )
    assert pacific.status_code == 200
    assert pacific.json()["meals"][1]["logged_at"].startswith("2026-11-16T13:00:00-08:00")

    # Reading does not acknowledge meals. Each acknowledgment follows the Health writes.
    still_pending = client.get(
        "/api/shortcuts/health-sync",
        params={"token": shortcut_token, "date": "2026-11-16", "tz_offset_minutes": 0, "unsynced_only": "true"},
    )
    assert still_pending.json()["meal_count"] == 2
    for meal in body_1["meals"]:
        acknowledged = client.post(
            "/api/shortcuts/health-sync", params={"token": shortcut_token, "meal_id": meal["id"]}
        )
        assert acknowledged.status_code == 200
        assert acknowledged.json()["synced_to_health"] is True

    # Second run with unsynced_only=true returns 0 unsynced meals (no double-counting in Apple Health)
    sync_2 = client.get(
        "/api/shortcuts/health-sync",
        params={"token": shortcut_token, "date": "2026-11-16", "tz_offset_minutes": 0, "unsynced_only": "true"},
    )
    assert sync_2.status_code == 200
    assert sync_2.json()["meal_count"] == 0
    assert sync_2.json()["unsynced_count"] == 0

    # Revoke token -> 401
    rev = client.delete("/api/shortcuts/token", headers=headers)
    assert rev.status_code == 200
    assert rev.json() == {"configured": False, "token": None}
    denied = client.get(
        "/api/shortcuts/health-sync",
        headers={"Authorization": f"Bearer {shortcut_token}"},
    )
    assert denied.status_code == 401


def test_apple_shortcut_file_prepare_and_download(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import plistlib
    from app import shortcut_builder

    # Verify plist structure embeds exact sync URL and all 16 actions
    sample_url = shortcut_builder.build_health_sync_url("http://192.168.1.10:5173/", "mls_test123")
    assert sample_url == (
        "http://192.168.1.10:5173/api/shortcuts/health-sync"
        "?token=mls_test123&unsynced_only=true"
    )
    plist_bytes = shortcut_builder.build_shortcut_plist_bytes(sample_url)
    doc = plistlib.loads(plist_bytes)
    actions = doc["WFWorkflowActions"]
    assert len(actions) == 18
    assert actions[0]["WFWorkflowActionIdentifier"] == "is.workflow.actions.gettext"
    assert actions[0]["WFWorkflowActionParameters"]["WFTextActionText"] == sample_url
    assert actions[1]["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"
    assert actions[2]["WFWorkflowActionIdentifier"] == "is.workflow.actions.getvalueforkey"
    assert actions[3]["WFWorkflowActionIdentifier"] == "is.workflow.actions.repeat.each"
    assert actions[5]["WFWorkflowActionIdentifier"] == "is.workflow.actions.detect.date"
    health_types = [
        a["WFWorkflowActionParameters"]["WFQuantitySampleType"]
        for a in actions
        if a["WFWorkflowActionIdentifier"] == "is.workflow.actions.health.quantity.log"
    ]
    assert health_types == ["Dietary Energy", "Protein", "Carbohydrates", "Total Fat"]
    assert actions[14]["WFWorkflowActionParameters"]["WFDictionaryKey"] == "id"
    assert actions[15]["WFWorkflowActionParameters"]["WFHTTPMethod"] == "POST"
    assert actions[16]["WFWorkflowActionIdentifier"] == "is.workflow.actions.repeat.each"
    assert actions[17]["WFWorkflowActionIdentifier"] == "is.workflow.actions.notification"

    auth = _signup_user(client, email="shortcutdl@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])
    shortcut_token = client.post("/api/shortcuts/token", headers=headers).json()["token"]

    shortcut_builder._SIGNED_CACHE.clear()
    monkeypatch.setattr(shortcut_builder, "sign_shortcut_plist", lambda _b: b"AEA1signedmock")

    prep = client.post(
        "/api/shortcuts/prepare",
        headers=headers,
        json={"token": shortcut_token, "base_url": "https://macros.example.com"},
    )
    assert prep.status_code == 200
    prep_json = prep.json()
    assert prep_json["mode"] == "baked"
    assert f"token={shortcut_token}" in prep_json["sync_url"]
    assert prep_json["download_url"].startswith("/api/shortcuts/download?")

    dl = client.get(prep_json["download_url"], headers=headers)
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "application/x-apple-shortcut"
    assert dl.headers["x-shortcut-mode"] == "baked"
    assert dl.content == b"AEA1signedmock"

    # Fallback to pre-signed template when shortcuts CLI is unavailable
    shortcut_builder._SIGNED_CACHE.clear()
    monkeypatch.setattr(shortcut_builder, "sign_shortcut_plist", lambda _b: None)

    prep_tpl = client.post(
        "/api/shortcuts/prepare",
        headers=headers,
        json={"token": shortcut_token, "base_url": "https://macros.example.com"},
    )
    assert prep_tpl.status_code == 200
    assert prep_tpl.json()["mode"] == "template"

    dl_tpl = client.get(prep_tpl.json()["download_url"], headers=headers)
    assert dl_tpl.status_code == 200
    assert dl_tpl.headers["content-type"] == "application/x-apple-shortcut"
    assert dl_tpl.headers["x-shortcut-mode"] == "template"
    assert dl_tpl.content[:4] == b"AEA1"

    # Wrong/revoked token rejected with 401
    bad_prep = client.post(
        "/api/shortcuts/prepare",
        headers=headers,
        json={"token": "mls_invalid_token_value", "base_url": "https://macros.example.com"},
    )
    assert bad_prep.status_code == 401
    bad_dl = client.get(
        "/api/shortcuts/download",
        headers=headers,
        params={"token": "mls_invalid_token_value"},
    )
    assert bad_dl.status_code == 401

    # Direct synchronous /api/shortcuts/install auto-provisions v2 token & authenticates via ?auth_token=<jwt>
    fresh = _signup_user(client, email="autoinstall@example.com", pin="1234")
    fresh_jwt = fresh["access_token"]
    fresh_headers = _auth_headers(fresh_jwt)
    assert client.get("/api/shortcuts/token", headers=fresh_headers).json() == {
        "configured": False,
        "token": None,
    }

    shortcut_builder._SIGNED_CACHE.clear()
    monkeypatch.setattr(shortcut_builder, "sign_shortcut_plist", lambda _b: b"AEA1autoinstall")
    install_res = client.get(
        "/api/shortcuts/install",
        params={"base_url": "https://macros.example.com"},
        headers=fresh_headers,
    )
    assert install_res.status_code == 200
    assert install_res.headers["content-type"] == "application/x-apple-shortcut"
    assert install_res.headers["x-shortcut-mode"] == "baked"
    assert install_res.content == b"AEA1autoinstall"

    post_status = client.get("/api/shortcuts/token", headers=fresh_headers).json()
    assert post_status["configured"] is True
    assert post_status["token"] and post_status["token"].startswith("mls_")


def test_production_spa_static_serving(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    dist_dir = tmp_path / "dist"
    assets_dir = dist_dir / "assets"
    assets_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html><body>MacroLens SPA</body></html>", encoding="utf-8")
    (dist_dir / "sw.js").write_text("// service worker", encoding="utf-8")
    (dist_dir / "manifest.webmanifest").write_text('{"name":"MacroLens"}', encoding="utf-8")
    (assets_dir / "app.js").write_text("console.log('ok');", encoding="utf-8")

    monkeypatch.setenv("FRONTEND_DIST_DIR", str(dist_dir))

    root = client.get("/")
    assert root.status_code == 200
    assert "MacroLens SPA" in root.text
    assert root.headers["cache-control"] == "no-cache"

    spa_route = client.get("/logs")
    assert spa_route.status_code == 200
    assert "MacroLens SPA" in spa_route.text

    sw_res = client.get("/sw.js")
    assert sw_res.status_code == 200
    assert sw_res.headers["cache-control"] == "no-cache"

    manifest_res = client.get("/manifest.webmanifest")
    assert manifest_res.status_code == 200
    assert manifest_res.headers["content-type"].startswith("application/manifest+json")

    asset_res = client.get("/assets/app.js")
    assert asset_res.status_code == 200
    assert asset_res.headers["cache-control"] == "public, max-age=31536000, immutable"

    api_404 = client.get("/api/unknown")
    assert api_404.status_code == 404
    assert api_404.json() == {"detail": "Not Found"}


def test_shortcut_sync_uses_local_date_for_evening_meal(client: TestClient) -> None:
    auth = _signup_user(client, email="shortcut-timezone@example.com", pin="1234")
    headers = _auth_headers(auth["access_token"])
    token = client.post("/api/shortcuts/token", headers=headers).json()["token"]
    meal = client.post("/api/meals", headers=headers, json={
        "meal_name": "Evening meal", "logged_at": "2026-11-17T02:30:00Z",
        "calories": 100, "protein_g": 5, "carbs_g": 10, "fat_g": 3,
    })
    assert meal.status_code == 201
    response = client.get("/api/shortcuts/health-sync", params={
        "token": token, "date": "2026-11-16", "tz_offset_minutes": 480,
    })
    assert response.status_code == 200
    assert response.json()["meals"][0]["logged_at"] == "2026-11-16T18:30:00-08:00"


def test_refine_uses_owned_photo_and_current_draft(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    owner = _signup_user(client, email="refine-photo@example.com")
    headers = _auth_headers(owner["access_token"])
    meal = client.post("/api/meals", headers=headers, json={"meal_name": "Dinner", "source": "photo", "calories": 500}).json()
    image = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(image, format="PNG")
    uploaded = client.post(f"/api/meals/{meal['id']}/photo", headers=headers, files={"image": ("meal.png", image.getvalue(), "image/png")})
    assert uploaded.status_code == 200
    draft = {"meal_name": "Dinner revised", "notes": "ate half", "items": [{"name": "potatoes", "calories": 100, "protein_g": 2, "carbs_g": 20, "fat_g": 1}], "total": {"calories": 300, "protein_g": 10, "carbs_g": 40, "fat_g": 8}}
    captured = {}
    def fake_raw(**kwargs):
        captured.update(kwargs)
        return json.dumps({"meal_name": "Dinner revised", "detected_reference": None, "confidence": "medium", "notes": "Removed potatoes", "total": {"calories": 200, "protein_g": 8, "carbs_g": 20, "fat_g": 7}, "items": []})
    monkeypatch.setattr(gemini_service, "_call_gemini_raw", fake_raw)
    response = client.post(f"/api/meals/{meal['id']}/refine", headers=headers, json={"instruction": "I did not eat potatoes", "current": draft})
    assert response.status_code == 200, response.text
    assert captured["media_bytes"] == client.get(f"/api/meals/{meal['id']}/photo", headers=headers).content
    assert captured["mime_type"] == "image/jpeg"
    assert 'Dinner revised' in captured["prompt"] and 'ate half' in captured["prompt"]
    assert 'potatoes' in captured["prompt"] and '300.0' in captured["prompt"]
    assert 'I did not eat potatoes' in captured["prompt"]
    assert response.json()["total"]["calories"] == 200
    saved = client.get("/api/meals/logs", headers=headers).json()["items"]
    assert next(item for item in saved if item["id"] == meal["id"])["calories"] == 500


@pytest.mark.parametrize(
    ("provider_message", "expected"),
    [
        ("Your project has exceeded its monthly spending cap.", "monthly spending cap was reached"),
        ("Quota exceeded for requests per minute.", "reached a usage limit"),
    ],
)
@pytest.mark.parametrize("transport", ["sdk", "rest"])
def test_photo_analysis_reports_provider_limit_clearly(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, provider_message: str, expected: str, transport: str,
) -> None:
    import urllib.error
    from google.genai.errors import ClientError

    user = _signup_user(client, email=f"limit-{transport}@example.com")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    if transport == "sdk":
        def fail_sdk(**kwargs: Any) -> str:
            raise ClientError(429, {"error": {"code": 429, "message": provider_message, "status": "RESOURCE_EXHAUSTED"}})
        monkeypatch.setattr(gemini_service, "_call_gemini_sdk", fail_sdk)
    else:
        monkeypatch.setattr(gemini_service, "genai", None)
        monkeypatch.setattr(gemini_service, "types", None)
        def fail_rest(*args: Any, **kwargs: Any) -> None:
            body = json.dumps({"error": {"message": provider_message}}).encode()
            raise urllib.error.HTTPError("https://example.invalid", 429, "rate limited", {}, io.BytesIO(body))
        monkeypatch.setattr(gemini_service.urllib.request, "urlopen", fail_rest)
    response = client.post(
        "/api/meals/analyze", headers=_auth_headers(user["access_token"]),
        files={"image": ("meal.jpg", io.BytesIO(b"\xff\xd8\xff\xe0fake"), "image/jpeg")},
    )
    assert response.status_code == 503
    assert expected in response.json()["detail"]
    assert "RESOURCE_EXHAUSTED" not in response.text
    assert provider_message not in response.text
    if "spending" not in provider_message:
        assert "spending cap" not in response.text
