# Data for the maintenance registration (completion) dialog: the last valid process values of a rule's variables, the
# checklist suggested by the rule's linked instructions, and the validation / snapshot of what the technician submits.
# Read-only with respect to monitoring: nothing here changes a rule, a parameter, a reading or a maintenance cycle.
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import AGGREGATION_LAST, AGGREGATION_NONE, NUMBER
from app.models import InstructionDocument, MaintenanceRecord, MaintenanceSchedule, MonitoringRule, Reading, Variable
from app.services.access_scope import hidden_document_ids
from app.services.rule_parameters import _aware, _as_bool, _as_number, effective_stale_after

LOOKBACK_DAYS = 7
READING_SCAN_LIMIT = 500  # newest readings examined per variable while looking for the last valid one
MAX_CHECKLIST_ITEMS = 100
MAX_ITEM_TEXT = 500
MAX_ITEM_NOTE = 2000
_STEP = re.compile(r"^\s*(?:[-*•]|\d{1,3}[.)])\s+(\S.*)$")

STATUS_OK, STATUS_STALE, STATUS_MISSING, STATUS_INVALID, STATUS_INACTIVE = "ok", "stale", "missing", "invalid", "inactive"
_STATUS_MESSAGE = {
    STATUS_OK: "Recent valid reading.",
    STATUS_STALE: "The last valid reading is older than the rule's freshness limit; check the value on site.",
    STATUS_MISSING: f"No reading in the previous {LOOKBACK_DAYS} days.",
    STATUS_INVALID: f"Readings exist in the previous {LOOKBACK_DAYS} days but none is a valid value.",
    STATUS_INACTIVE: "The variable is inactive.",
}


def _iso(value: datetime) -> str:
    return _aware(value).astimezone(timezone.utc).isoformat()


# "number" for a plain Number parameter; every other parameter reads an on/off signal.
def _expected_type(parameter) -> str:
    if parameter.kind == NUMBER and (parameter.aggregation or AGGREGATION_NONE) in {AGGREGATION_NONE, AGGREGATION_LAST}:
        return "number"
    return "boolean"


def _valid(value: Any, expected: str) -> bool:
    return _as_number(value) is not None if expected == "number" else _as_bool(value) is not None


def _normalized_value(value: Any, expected: str) -> Any:
    return _as_number(value) if expected == "number" else _as_bool(value)


# The last valid reading of one variable within the lookback window, with a status that flags problems.
def _last_valid_reading(session: Session, variable: Variable, expected: str, stale_after: int, now: datetime) -> dict[str, Any]:
    since = now - timedelta(days=LOOKBACK_DAYS)
    readings = session.scalars(
        select(Reading).where(Reading.variable_id == variable.id, Reading.recorded_at >= since, Reading.recorded_at <= now)
        .order_by(Reading.recorded_at.desc(), Reading.id.desc()).limit(READING_SCAN_LIMIT)).all()
    valid = next((item for item in readings if _valid(item.value, expected)), None)
    if valid is None:
        status = STATUS_INVALID if readings else STATUS_MISSING
        return {"value": None, "recorded_at": None, "age_seconds": None, "status": status, "message": _STATUS_MESSAGE[status]}
    age = max(0.0, (now - _aware(valid.recorded_at)).total_seconds())
    status = STATUS_STALE if age > stale_after else STATUS_OK
    message = _STATUS_MESSAGE[status]
    if readings[0] is not valid:
        message += " A newer reading was not a valid value."
    if not variable.is_active:
        status, message = STATUS_INACTIVE, _STATUS_MESSAGE[STATUS_INACTIVE]
    return {"value": _normalized_value(valid.value, expected), "recorded_at": _iso(valid.recorded_at),
            "age_seconds": int(age), "status": status, "message": message}


def _rule_for(session: Session, record: MaintenanceRecord) -> tuple[MonitoringRule | None, MaintenanceSchedule | None]:
    schedule = session.get(MaintenanceSchedule, record.schedule_id) if record.schedule_id else None
    rule = session.get(MonitoringRule, schedule.source_rule_id) if schedule is not None and schedule.source_rule_id else None
    return rule, schedule


# One entry per parameter of the record's rule that reads a variable (the parameter that created the job comes first).
def process_values(session: Session, record: MaintenanceRecord, now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    rule, schedule = _rule_for(session, record)
    if rule is None or schedule is None or schedule.schedule_mode != "rule":
        return []
    stale_after = effective_stale_after(rule)
    entries = []
    for parameter in sorted(rule.parameter_items, key=lambda item: (item.id != schedule.source_parameter_id, item.position, item.id)):
        variable = session.get(Variable, parameter.variable_id) if parameter.variable_id else None
        if variable is None:
            continue  # e.g. Calendar Time: nothing to read
        expected = _expected_type(parameter)
        reading = _last_valid_reading(session, variable, expected, stale_after, now)
        entries.append({
            "parameter_id": parameter.id, "parameter_key": parameter.key, "parameter_name": parameter.name,
            "is_source_parameter": parameter.id == schedule.source_parameter_id,
            "rule_id": rule.id, "rule_name": rule.name,
            "variable_id": variable.id, "variable_key": variable.key, "variable_name": variable.name,
            "unit": variable.unit or ((parameter.config or {}).get("unit") or None),
            "expected_type": expected, "lookback_days": LOOKBACK_DAYS, "stale_after_seconds": stale_after,
            "last_recorded": reading,
        })
    return entries


def _clean_text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


# Structured checklist: [{id, item, completed, note, source, instruction_id}]. "item" and "completed" keep the keys the
# older free-text checklist used, so existing records (which have neither id nor note) stay readable and valid.
def normalize_checklist(items: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if items is None:
        return None
    if len(items) > MAX_CHECKLIST_ITEMS:
        raise ValueError(f"A checklist can have at most {MAX_CHECKLIST_ITEMS} items.")
    result, seen = [], set()
    for position, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise ValueError("Each checklist item must be an object.")
        text = _clean_text(raw.get("item", raw.get("text")), 10_000)
        if not text:
            continue
        if len(text) > MAX_ITEM_TEXT:
            raise ValueError(f"A checklist item can have at most {MAX_ITEM_TEXT} characters.")
        item_id = _clean_text(raw.get("id"), 64) or f"custom-{uuid.uuid4().hex[:8]}"
        if item_id in seen:
            item_id = f"{item_id}-{position}"
        seen.add(item_id)
        note = _clean_text(raw.get("note"), 10_000)
        if len(note) > MAX_ITEM_NOTE:
            raise ValueError(f"A checklist note can have at most {MAX_ITEM_NOTE} characters.")
        source = raw.get("source") if raw.get("source") in {"instruction", "custom"} else ("instruction" if raw.get("instruction_id") else "custom")
        instruction_id = raw.get("instruction_id")
        result.append({
            "id": item_id, "item": text, "completed": bool(raw.get("completed")), "note": note or None, "source": source,
            "instruction_id": instruction_id if isinstance(instruction_id, int) and not isinstance(instruction_id, bool) else None,
        })
    return result


# Items suggested by the instructions linked to the record's rule. No instruction is mandatory: nothing is pre-checked.
def instruction_checklist(session: Session, record: MaintenanceRecord) -> list[dict[str, Any]]:
    rule, schedule = _rule_for(session, record)
    if schedule is None or schedule.schedule_mode != "rule":
        return []
    ids = (rule.parameters or {}).get("document_ids") if rule is not None else None
    if not ids:
        ids = schedule.instruction_document_ids or []
    hidden = hidden_document_ids(session)
    items: list[dict[str, Any]] = []
    for document_id in ids:
        if isinstance(document_id, bool) or not isinstance(document_id, int) or document_id in hidden:
            continue
        document = session.get(InstructionDocument, document_id)
        if document is None:
            continue
        steps = [match.group(1).strip() for line in (document.description or "").splitlines() if (match := _STEP.match(line))]
        if document.entry_type == "instruction" and len(steps) >= 2:
            items += [{"id": f"inst-{document.id}-{number}", "item": step[:MAX_ITEM_TEXT], "completed": False, "note": None,
                       "source": "instruction", "instruction_id": document.id, "instruction_title": document.title}
                      for number, step in enumerate(steps, start=1)]
        else:
            items.append({"id": f"inst-{document.id}", "item": (document.title or "Instruction")[:MAX_ITEM_TEXT], "completed": False,
                          "note": None, "source": "instruction", "instruction_id": document.id, "instruction_title": document.title})
    return items[:MAX_CHECKLIST_ITEMS]


# The record's own checklist (old free-text items included) first, then instruction items it does not already contain.
def registration_checklist(session: Session, record: MaintenanceRecord) -> list[dict[str, Any]]:
    existing = []
    for position, raw in enumerate(record.checklist or [], start=1):
        if isinstance(raw, dict) and isinstance(raw.get("item"), str) and raw["item"].strip():
            existing.append({"id": raw.get("id") or f"item-{position}", "item": raw["item"], "completed": bool(raw.get("completed")),
                             "note": raw.get("note") or None, "source": raw.get("source") or "custom",
                             "instruction_id": raw.get("instruction_id")})
    known_ids = {item["id"] for item in existing}
    known_text = {item["item"].strip().casefold() for item in existing}
    merged = existing + [item for item in instruction_checklist(session, record)
                         if item["id"] not in known_ids and item["item"].strip().casefold() not in known_text]
    return merged[:MAX_CHECKLIST_ITEMS]


def registration_context(session: Session, record: MaintenanceRecord) -> dict[str, Any]:
    return {"record_id": record.id, "lookback_days": LOOKBACK_DAYS, "actual_values": process_values(session, record),
            "checklist": registration_checklist(session, record)}


def _same(first: Any, second: Any) -> bool:
    if isinstance(first, bool) or isinstance(second, bool):
        return first is second
    return first is not None and second is not None and math.isclose(float(first), float(second), rel_tol=0, abs_tol=1e-9)


# The snapshot stored on the maintenance record. It copies names, units and values, so history stays correct if the
# rule, parameter or variable is renamed or deleted later. The automatically retrieved value ("last_recorded", read
# again here from the readings) and the technician's value ("confirmed") are stored separately.
def build_actual_values(session: Session, record: MaintenanceRecord, submitted: list[dict[str, Any]], user_name: str,
                        now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    entries = process_values(session, record, now)
    by_parameter = {entry["parameter_id"]: entry for entry in entries}
    chosen: dict[int, Any] = {}
    for raw in submitted:
        parameter_id = raw.get("parameter_id")
        if parameter_id not in by_parameter:
            raise ValueError("An actual value refers to a parameter that does not belong to this maintenance's rule.")
        if parameter_id in chosen:
            raise ValueError("An actual value was submitted twice for the same parameter.")
        value = raw.get("confirmed_value")
        if value is not None:
            expected = by_parameter[parameter_id]["expected_type"]
            if expected == "number":
                if _as_number(value) is None:
                    raise ValueError(f"The actual value for '{by_parameter[parameter_id]['parameter_name']}' must be a number.")
                value = _as_number(value)
            else:
                if not isinstance(value, (bool, str)) or _as_bool(value) is None:
                    raise ValueError(f"The actual value for '{by_parameter[parameter_id]['parameter_name']}' must be TRUE or FALSE.")
                value = _as_bool(value)
        chosen[parameter_id] = value
    result = []
    for entry in entries:
        value = chosen.get(entry["parameter_id"])
        last = entry["last_recorded"]
        confirmed = None
        if value is not None:
            confirmed = {"value": value, "confirmed_at": _iso(now), "confirmed_by": user_name,
                         "method": "confirmed" if _same(value, last["value"]) else "entered"}
        result.append({**{key: entry[key] for key in (
            "parameter_id", "parameter_key", "parameter_name", "rule_id", "rule_name", "variable_id", "variable_key",
            "variable_name", "unit", "expected_type")}, "last_recorded": last, "confirmed": confirmed})
    return result
