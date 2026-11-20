# Component identifier: an optional tag (for example "P-101") on a rule assigned to an asset. It lives on the asset's
# own rule (MonitoringRule.component_identifier) because a shared rule is used by many assets.
# One normalisation serves every entry point (create, assign, copy, edit, filters): whitespace is trimmed and
# collapsed, blank means "no identifier" (None), case is kept for display, and filters match case-insensitively.
from __future__ import annotations

import re
from typing import Any

MAX_COMPONENT_IDENTIFIER_LENGTH = 100
_ALLOWED = re.compile(r"^[\w .,:;#/\\()+&'\-]+$", re.UNICODE)


def normalize_component_identifier(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("The component identifier must be text.")
    text = re.sub(r"\s+", " ", value).strip()
    if not text:
        return None
    if len(text) > MAX_COMPONENT_IDENTIFIER_LENGTH:
        raise ValueError(f"The component identifier can be at most {MAX_COMPONENT_IDENTIFIER_LENGTH} characters.")
    if not _ALLOWED.match(text):
        raise ValueError("The component identifier can contain letters, numbers, spaces and . , : ; # / \\ ( ) + & ' - _ only.")
    return text
