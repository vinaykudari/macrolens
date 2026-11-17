"""Builder and macOS signer for pre-configured Apple Health .shortcut files."""

from __future__ import annotations

import hashlib
import plistlib
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

TEMPLATE_SHORTCUT_PATH = (
    Path(__file__).resolve().parent / "assets" / "MacroLens-Health-Sync-Template.shortcut"
)

_MAX_CACHE_ENTRIES = 64
_SIGNED_CACHE: dict[str, tuple[bytes, str]] = {}

_U_TEXT = "11111111-2222-4333-8444-555555555500"
_U_DL = "11111111-2222-4333-8444-555555555501"
_U_MEALS = "11111111-2222-4333-8444-555555555502"
_U_REP0 = "11111111-2222-4333-8444-555555555503"
_U_DT_RAW = "11111111-2222-4333-8444-555555555504"
_U_DT = "11111111-2222-4333-8444-555555555505"
_U_GROUP = "11111111-2222-4333-8444-555555555599"

_HEALTH_METRICS: tuple[tuple[str, str, str, str, str], ...] = (
    ("calories", "Dietary Energy", "kcal", "11111111-2222-4333-8444-555555555506", "11111111-2222-4333-8444-555555555510"),
    ("protein_g", "Protein", "g", "11111111-2222-4333-8444-555555555507", "11111111-2222-4333-8444-555555555511"),
    ("carbs_g", "Carbohydrates", "g", "11111111-2222-4333-8444-555555555508", "11111111-2222-4333-8444-555555555512"),
    ("fat_g", "Total Fat", "g", "11111111-2222-4333-8444-555555555509", "11111111-2222-4333-8444-555555555513"),
)


def build_health_sync_url(base_url: str, raw_token: str) -> str:
    """Build a validated Apple Shortcuts health-sync URL with the user's token embedded."""
    parts = urllib.parse.urlsplit(base_url.strip())
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("base_url must be a valid http or https URL with a host")

    clean_path = parts.path.rstrip("/")
    clean_base = f"{scheme}://{parts.netloc}{clean_path}"
    encoded_token = urllib.parse.quote(raw_token.strip(), safe="")
    return (
        f"{clean_base}/api/shortcuts/health-sync"
        f"?token={encoded_token}&unsynced_only=true"
    )


def _repeat_item_get_key(key: str, uid: str) -> dict[str, Any]:
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
        "WFWorkflowActionParameters": {
            "UUID": uid,
            "WFGetDictionaryValueType": "Value",
            "WFDictionaryKey": key,
            "WFInput": {
                "Value": {"Type": "Variable", "VariableName": "Repeat Item"},
                "WFSerializationType": "WFTextTokenAttachment",
            },
        },
    }


def _health_sample_action(sample_type: str, unit: str, val_uuid: str, uid: str) -> dict[str, Any]:
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.health.quantity.log",
        "WFWorkflowActionParameters": {
            "UUID": uid,
            "WFQuantitySampleType": sample_type,
            "WFQuantitySampleQuantity": {
                "Value": {
                    "Magnitude": {
                        "Value": {
                            "OutputName": "Dictionary Value",
                            "OutputUUID": val_uuid,
                            "Type": "ActionOutput",
                        },
                        "WFSerializationType": "WFTextTokenAttachment",
                    },
                    "Unit": unit,
                },
                "WFSerializationType": "WFQuantityFieldValue",
            },
            "WFQuantitySampleDate": {
                "Value": {
                    "attachmentsByRange": {
                        "{0, 1}": {
                            "OutputName": "Dates",
                            "OutputUUID": _U_DT,
                            "Type": "ActionOutput",
                        }
                    },
                    "string": "\ufffc",
                },
                "WFSerializationType": "WFTextTokenString",
            },
        },
    }


def build_shortcut_plist_bytes(sync_url: str, *, include_import_question: bool = False) -> bytes:
    """Serialize the Apple Shortcuts Health sync workflow to binary plist bytes."""
    actions: list[dict[str, Any]] = [
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
            "WFWorkflowActionParameters": {
                "UUID": _U_TEXT,
                "WFTextActionText": sync_url,
            },
        },
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": {
                "UUID": _U_DL,
                "WFHTTPMethod": "GET",
                "WFURL": {
                    "Value": {
                        "attachmentsByRange": {
                            "{0, 1}": {
                                "OutputName": "Text",
                                "OutputUUID": _U_TEXT,
                                "Type": "ActionOutput",
                            }
                        },
                        "string": "\ufffc",
                    },
                    "WFSerializationType": "WFTextTokenString",
                },
            },
        },
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": {
                "UUID": _U_MEALS,
                "WFGetDictionaryValueType": "Value",
                "WFDictionaryKey": "meals",
                "WFInput": {
                    "Value": {
                        "OutputName": "Contents of URL",
                        "OutputUUID": _U_DL,
                        "Type": "ActionOutput",
                    },
                    "WFSerializationType": "WFTextTokenAttachment",
                },
            },
        },
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.repeat.each",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": _U_GROUP,
                "UUID": _U_REP0,
                "WFControlFlowMode": 0,
                "WFInput": {
                    "Value": {
                        "OutputName": "Dictionary Value",
                        "OutputUUID": _U_MEALS,
                        "Type": "ActionOutput",
                    },
                    "WFSerializationType": "WFTextTokenAttachment",
                },
            },
        },
        _repeat_item_get_key("logged_at", _U_DT_RAW),
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.detect.date",
            "WFWorkflowActionParameters": {
                "UUID": _U_DT,
                "WFInput": {
                    "Value": {
                        "OutputName": "Dictionary Value",
                        "OutputUUID": _U_DT_RAW,
                        "Type": "ActionOutput",
                    },
                    "WFSerializationType": "WFTextTokenAttachment",
                },
            },
        },
    ]

    for key, sample_type, unit, get_uid, log_uid in _HEALTH_METRICS:
        actions.append(_repeat_item_get_key(key, get_uid))
        actions.append(_health_sample_action(sample_type, unit, get_uid, log_uid))

    # Acknowledge a meal only after its four Health writes have succeeded.
    meal_id_uuid = "11111111-2222-4333-8444-555555555515"
    actions.append(_repeat_item_get_key("id", meal_id_uuid))
    actions.append({
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "UUID": "11111111-2222-4333-8444-555555555516",
            "WFHTTPMethod": "POST",
            "WFURL": {
                "Value": {
                    "attachmentsByRange": {
                        "{0, 1}": {"OutputName": "Text", "OutputUUID": _U_TEXT, "Type": "ActionOutput"},
                        "{10, 1}": {"OutputName": "Dictionary Value", "OutputUUID": meal_id_uuid, "Type": "ActionOutput"},
                    },
                    "string": "\ufffc&meal_id=\ufffc",
                },
                "WFSerializationType": "WFTextTokenString",
            },
        },
    })

    actions.extend(
        [
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.repeat.each",
                "WFWorkflowActionParameters": {
                    "GroupingIdentifier": _U_GROUP,
                    "UUID": "11111111-2222-4333-8444-555555555514",
                    "WFControlFlowMode": 2,
                },
            },
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.notification",
                "WFWorkflowActionParameters": {
                    "UUID": "11111111-2222-4333-8444-555555555517",
                    "WFNotificationActionTitle": "MacroLens Health Sync",
                    "WFNotificationActionBody": "Synced new meals to Apple Health.",
                },
            },
        ]
    )

    import_questions: list[dict[str, Any]] = []
    if include_import_question:
        import_questions.append(
            {
                "ActionIndex": 0,
                "Category": "Parameter",
                "DefaultValue": sync_url,
                "ParameterKey": "WFTextActionText",
                "Text": "Paste your MacroLens Sync URL (includes your token):",
            }
        )

    doc: dict[str, Any] = {
        "WFWorkflowActions": actions,
        "WFWorkflowClientVersion": "2605.0.5",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowIcon": {
            "WFWorkflowIconStartColor": 463140863,
            "WFWorkflowIconGlyphNumber": 59728,
        },
        "WFWorkflowImportQuestions": import_questions,
        "WFWorkflowInputContentItemClasses": [
            "WFStringContentItem",
            "WFURLContentItem",
        ],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": [],
    }
    return plistlib.dumps(doc, fmt=plistlib.FMT_BINARY)


def sign_shortcut_plist(plist_bytes: bytes, timeout_seconds: float = 30.0) -> bytes | None:
    """Sign a binary shortcut plist via macOS shortcuts CLI, or return None if unavailable."""
    shortcuts_bin = shutil.which("shortcuts")
    if not shortcuts_bin:
        return None

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            in_path = Path(tmp_dir) / "in.shortcut"
            out_path = Path(tmp_dir) / "out.shortcut"
            in_path.write_bytes(plist_bytes)
            proc = subprocess.run(
                [
                    shortcuts_bin,
                    "sign",
                    "--mode",
                    "anyone",
                    "--input",
                    str(in_path),
                    "--output",
                    str(out_path),
                ],
                capture_output=True,
                timeout=timeout_seconds,
            )
            if proc.returncode != 0 or not out_path.exists():
                return None
            signed_bytes = out_path.read_bytes()
            return signed_bytes if signed_bytes.startswith(b"AEA1") else None
    except (OSError, subprocess.SubprocessError):
        return None


def get_or_build_signed_shortcut(sync_url: str) -> tuple[bytes, str]:
    """Return a signed AEA1 shortcut file and its mode ('baked' or 'template')."""
    cache_key = hashlib.sha256(sync_url.encode("utf-8")).hexdigest()
    cached = _SIGNED_CACHE.get(cache_key)
    if cached is not None:
        return cached

    plist_bytes = build_shortcut_plist_bytes(sync_url, include_import_question=False)
    signed_bytes = sign_shortcut_plist(plist_bytes)
    if signed_bytes is not None:
        if len(_SIGNED_CACHE) >= _MAX_CACHE_ENTRIES:
            oldest_key = next(iter(_SIGNED_CACHE))
            _SIGNED_CACHE.pop(oldest_key, None)
        result = (signed_bytes, "baked")
        _SIGNED_CACHE[cache_key] = result
        return result

    if TEMPLATE_SHORTCUT_PATH.exists():
        template_bytes = TEMPLATE_SHORTCUT_PATH.read_bytes()
        if template_bytes.startswith(b"AEA1"):
            return (template_bytes, "template")

    raise RuntimeError(
        "Shortcut signing is unavailable on this host and no pre-signed template was found."
    )
