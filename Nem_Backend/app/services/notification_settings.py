# Per-rule email notification settings: Warning/Alert on-off switches and an optional custom message.
from __future__ import annotations
import re
from typing import Any
from app.core.constants import STATUS_ALERT, STATUS_WARNING

NOTIFICATION_SETTINGS_KEY = "notifications"
NOTIFICATION_SEVERITIES = (STATUS_WARNING, STATUS_ALERT)
MAX_CUSTOM_MESSAGE_LENGTH = 500
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class NotificationSettingsError(ValueError):
    pass


def clean_custom_message(value: Any) -> str | None:
    # Trim and validate a custom message. Empty or whitespace-only means "use the default" (None).
    if value is None:
        return None
    if not isinstance(value, str):
        raise NotificationSettingsError("The custom message must be text.")
    text = re.sub(r"\s*[\r\n]+\s*", " ", value).strip()
    if not text:
        return None
    if _CONTROL_CHARS.search(text):
        raise NotificationSettingsError("The custom message contains invalid characters.")
    if len(text) > MAX_CUSTOM_MESSAGE_LENGTH:
        raise NotificationSettingsError(f"The custom message can be at most {MAX_CUSTOM_MESSAGE_LENGTH} characters.")
    return text


def normalize_notification_settings(raw: Any) -> dict[str, dict[str, Any]]:
    # Strictly validate submitted settings. Missing severities keep the default (enabled, no message).
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise NotificationSettingsError("Notification settings must be an object.")
    unknown = set(raw) - set(NOTIFICATION_SEVERITIES)
    if unknown:
        raise NotificationSettingsError(f"Unsupported notification severity: {', '.join(sorted(map(str, unknown)))}. "
            "Only Warning and Alert can be configured.")
    result: dict[str, dict[str, Any]] = {}
    for severity in NOTIFICATION_SEVERITIES:
        item = raw.get(severity, {})
        if not isinstance(item, dict):
            raise NotificationSettingsError(f"The {severity} setting must be an object.")
        extra = set(item) - {"enabled", "message"}
        if extra:
            raise NotificationSettingsError(f"Unsupported {severity} setting: {', '.join(sorted(map(str, extra)))}.")
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise NotificationSettingsError(f"The {severity} 'enabled' value must be true or false.")
        result[severity] = {"enabled": enabled, "message": clean_custom_message(item.get("message"))}
    return result


def settings_for_rule(rule: Any) -> dict[str, dict[str, Any]]:
    # Effective settings of a rule. Tolerant: anything unreadable falls back to the defaults.
    stored = (getattr(rule, "parameters", None) or {}).get(NOTIFICATION_SETTINGS_KEY) if rule is not None else None
    try:
        return normalize_notification_settings(stored)
    except NotificationSettingsError:
        return normalize_notification_settings(None)


def severity_enabled(rule: Any, severity: str) -> bool:
    if rule is None or severity not in NOTIFICATION_SEVERITIES:
        return True
    return settings_for_rule(rule)[severity]["enabled"]


def custom_message(rule: Any, severity: str) -> str | None:
    if rule is None or severity not in NOTIFICATION_SEVERITIES:
        return None
    return settings_for_rule(rule)[severity]["message"]
