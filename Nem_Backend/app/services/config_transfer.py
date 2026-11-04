"""Portable export / import of reusable configuration (Administrators only).
Three categories travel in one versioned JSON package:
monitoring_rules  - shared rules that are not part of a collection
collection_rules  - rule collections together with their shared rules
maintenance_rules- recurring maintenance definitions (not occurrences or history)
Import is two-phase. analyse validates everything and writes nothing; apply_import
re-runs that analysis and then creates every record in the caller's transaction, so a failure
leaves no partial configuration. Existing records are never overwritten.
"""
#Main business logic for exporting and importing config. packages.
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Asset,
    MaintenanceSchedule,
    MonitoringRuleTemplate,
    RuleCollection,
    User,
)
from app.models.config_import import ConfigurationImport
from app.models.rule_visibility import RuleTemplateChange, VISIBILITY_TYPES
from app.schemas.maintenance import MaintenanceScheduleCreate
from app.schemas.rule import RuleTemplateCreate
from app.core.labels import normalize_label_names
from app.services.labels import assign_labels
from app.services.rule_visibility import apply_visibility

APPLICATION_ID = "nem-plant-monitoring"
FORMAT_NAME = "nem-configuration-export"
FORMAT_VERSION = "1.0"
SUPPORTED_MAJOR_VERSION = 1
MAX_ITEMS_PER_CATEGORY = 1000
CATEGORIES = ("monitoring_rules", "collection_rules", "maintenance_rules")
MAX_COLLECTION_RULES = 5
# Runtime-timing keys that belong to one installation's operation, not to the definition.
_NON_PORTABLE_PARAMETERS = frozenset({"activation_at"})
_EXPORTED_SCHEDULE_STATUSES = ("active", "paused")

# Defines what admin can choose when importing.
class ImportOptions(BaseModel):
    on_duplicate: Literal["skip", "rename"] = "skip"
    # False (default): any invalid item rejects the whole import. True: invalid items are
    # reported as failed and the valid ones are imported.
    skip_invalid: bool = False
    # asset key (see _asset_key) -> destination asset id, chosen by the Administrator.
    asset_mappings: dict[str, int] = Field(default_factory=dict)
    # source Supervisor username -> destination Supervisor user ids, chosen by the Administrator.
    supervisor_mappings: dict[str, list[int]] = Field(default_factory=dict)
    # Day 0 for imported maintenance definitions (default: today, UTC).
    maintenance_start_date: date | None = None

# Extends these options by adding the actual JSON package.
class ImportRequest(ImportOptions):
    package: dict[str, Any]

# Convert a datetime into UTC ISO format.
def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None

# Imp. this decides exactly which feilds of a shared rule are exported.
def _template_item(template: MonitoringRuleTemplate) -> dict[str, Any]:
    parameters = {
        key: value for key, value in (template.parameters or {}).items()
        if key not in _NON_PORTABLE_PARAMETERS
    }
    return {
        "name": template.name,
        "description": template.description,
        "labels": sorted(template.labels),
        "rule_type": template.rule_type,
        "required_variable_types": template.required_variable_types,
        "variable_key": template.variable_key,
        "operator": template.operator,
        "threshold": None if template.threshold is None else format(template.threshold.normalize(), "f"),
        "parameters": parameters or None,
        "severity": template.severity,
        "is_enabled": template.is_enabled,
        "evaluation_interval_seconds": template.evaluation_interval_seconds,
        "stale_after_seconds": template.stale_after_seconds,
        "visibility": {
            "type": template.visibility_type,
            "supervisors": sorted(user.username for user in template.visibility_supervisors),
        },
    }

#Returns a portable ref. to an asset.
def _asset_reference(session: Session, asset: Asset) -> dict[str, Any]:
    parent = session.get(Asset, asset.parent_asset_id) if asset.parent_asset_id else None
    return {"name": asset.name, "asset_type": asset.asset_type, "parent_name": parent.name if parent else None}

# Main export function 
def build_export(session: Session) -> dict[str, Any]:
    templates = session.scalars(select(MonitoringRuleTemplate).order_by(MonitoringRuleTemplate.id)).all()
    standalone = [t for t in templates if t.collection_id is None]
    collections = session.scalars(select(RuleCollection).order_by(RuleCollection.id)).all()
    schedules = session.scalars(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.status.in_(_EXPORTED_SCHEDULE_STATUSES))
        .order_by(MaintenanceSchedule.id)
    ).all()

    monitoring = [{"ref": f"MR-{i}", **_template_item(t)} for i, t in enumerate(standalone, 1)]
    collection_items = []
    for i, collection in enumerate(collections, 1):
        members = [t for t in templates if t.collection_id == collection.id]
        collection_items.append({
            "ref": f"CR-{i}",
            "name": collection.name,
            "description": collection.description,
            "labels": sorted(collection.labels),
            "rules": [_template_item(t) for t in members],
        })
    maintenance = []
    for i, schedule in enumerate(schedules, 1):
        asset = session.get(Asset, schedule.asset_id)
        if asset is None:
            continue
        maintenance.append({
            "ref": f"MT-{i}",
            "title": schedule.title,
            "maintenance_type": schedule.maintenance_type,
            "priority": schedule.priority,
            "assigned_technician": schedule.assigned_technician,
            "description": schedule.description,
            "asset": _asset_reference(session, asset),
            "recurrence": {
                "enabled": schedule.recurrence_enabled,
                "interval": schedule.recurrence_interval,
                "unit": schedule.recurrence_unit,
            },
            "first_due_offset_days": max(0, (schedule.first_due_date - schedule.schedule_start_date).days),
        })
    return {
        "application": APPLICATION_ID,
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "exported_at": _iso(datetime.now(timezone.utc)),
        "contents": {
            "monitoring_rules": monitoring,
            "collection_rules": collection_items,
            "maintenance_rules": maintenance,
        },
    }

#Creates a portable lookup key from an asset reference.
def _asset_key(reference: dict[str, Any]) -> str:
    parent = reference.get("parent_name") or ""
    return f"{reference.get('asset_type', '')}::{reference.get('name', '')}::{parent}"

# Convert pydantic validation errors into readable messages.
def _error_text(error: ValidationError) -> list[str]:
    messages = []
    for item in error.errors(include_url=False):
        location = ".".join(str(part) for part in item["loc"])
        message = str(item["msg"]).removeprefix("Value error, ")
        messages.append(f"{location}: {message}" if location else message)
    return messages

# This validates the package envelope before processing its entries.
def check_package(package: Any) -> dict[str, list]:
    # Validate the envelope (application, format, version, structure); raise 422 when unusable.
    problems: list[str] = []
    if not isinstance(package, dict):
        raise HTTPException(status_code=422, detail="The file must contain a JSON object.")
    if package.get("application") != APPLICATION_ID or package.get("format") != FORMAT_NAME:
        problems.append("This is not a NEM configuration export (unknown application or format).")
    version = str(package.get("format_version", ""))
    major = version.split(".")[0]
    if not major.isdecimal():
        problems.append("The export format version is missing or invalid.")
    elif int(major) != SUPPORTED_MAJOR_VERSION:
        problems.append(f"Export format version {version} is not supported (supported: {SUPPORTED_MAJOR_VERSION}.x).")
    contents = package.get("contents")
    if not isinstance(contents, dict):
        problems.append("The export has no 'contents' section.")
        contents = {}
    result: dict[str, list] = {}
    for category in CATEGORIES:
        items = contents.get(category, [])
        if not isinstance(items, list):
            problems.append(f"'{category}' must be a list.")
            items = []
        elif len(items) > MAX_ITEMS_PER_CATEGORY:
            problems.append(f"'{category}' has more than {MAX_ITEMS_PER_CATEGORY} entries.")
            items = []
        result[category] = items
    if not any(result.values()) and not problems:
        problems.append("The export contains no monitoring, collection or maintenance rules.")
    if problems:
        raise HTTPException(status_code=422, detail=" ".join(problems))
    return result


class _Names:
    # Tracks names already used in the destination and earlier in the same package.
    def __init__(self, existing: set[str]):
        self.used = {name.casefold() for name in existing}
    def taken(self, name: str) -> bool:
        return name.casefold() in self.used
    def claim(self, name: str) -> None:
        self.used.add(name.casefold())
    def unique(self, name: str) -> str:
        for number in range(1, 1000):
            suffix = " (imported)" if number == 1 else f" (imported {number})"
            candidate = f"{name[: 200 - len(suffix)]}{suffix}"
            if not self.taken(candidate):
                return candidate
        raise HTTPException(status_code=409, detail=f"Cannot find a free name for '{name}'.")

# This function rebuilds rule visibility in the destination installation. 
def _resolve_visibility(raw: Any, supervisors: dict[str, User], options: ImportOptions, valid_ids: dict[int, User]):
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(raw, dict) or raw.get("type") not in VISIBILITY_TYPES:
        errors.append("visibility: an explicit visibility of 'admin_only' or 'specific_supervisors' is required.")
        return "admin_only", [], errors, warnings, []
    if raw["type"] == "admin_only":
        return "admin_only", [], errors, warnings, []
    names = raw.get("supervisors")
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        errors.append("visibility.supervisors must be a list of usernames.")
        return "admin_only", [], errors, warnings, []
    resolved: dict[int, User] = {}
    unresolved: list[str] = []
    for username in names:
        mapped = options.supervisor_mappings.get(username)
        if mapped:
            users = [valid_ids.get(user_id) for user_id in mapped]
            if any(user is None for user in users):
                errors.append(f"Supervisor mapping for '{username}' contains an unknown or inactive Supervisor.")
                continue
            resolved.update({user.id: user for user in users})
        elif username.casefold() in supervisors:
            user = supervisors[username.casefold()]
            resolved[user.id] = user
        else:
            unresolved.append(username)
    if unresolved:
        warnings.append("No matching active Supervisor in this installation for: " + ", ".join(sorted(unresolved)) + ".")
    if not resolved:
        warnings.append("No Supervisor could be assigned, so the rule will be imported as Admin Only.")
        return "admin_only", [], errors, warnings, unresolved
    return "specific_supervisors", sorted(resolved), errors, warnings, unresolved

# This validates one shared rule.then remaining rule defination using RuleTemplateCreate.
def _parse_template(raw: Any, supervisors, options, valid_ids):
    # Validate one exported shared rule -> (payload|None, visibility tuple, errors, warnings).
    if not isinstance(raw, dict):
        return None, ("admin_only", []), ["Entry must be an object."], [], []
    data = {k: v for k, v in raw.items() if k not in {"ref", "visibility"}}
    errors: list[str] = []
    payload = None
    try:
        payload = RuleTemplateCreate.model_validate({**data, "collection_id": None})
    except ValidationError as error:
        errors.extend(_error_text(error))
    vis_type, ids, vis_errors, warnings, unresolved = _resolve_visibility(
        raw.get("visibility"), supervisors, options, valid_ids
    )
    errors.extend(vis_errors)
    return payload, (vis_type, ids), errors, warnings, unresolved

# heart of import preview -> Its responsibility is to validate everything without writing to the db.
def analyse(session: Session, package: Any, options: ImportOptions) -> dict[str, Any]:
 # Validate a package against this installation. Writes nothing.
# Returns a report for the preview plus the private _work list used by apply_import.

    contents = check_package(package)
    active_supervisors = session.scalars(
        select(User).where(User.role == "Supervisor", User.is_active.is_(True))
    ).all()
    supervisors = {user.username.casefold(): user for user in active_supervisors}
    valid_ids = {user.id: user for user in active_supervisors}

    standalone_names = _Names({
        name for (name,) in session.execute(
            select(MonitoringRuleTemplate.name).where(MonitoringRuleTemplate.collection_id.is_(None))
        )
    })
    collection_names = _Names({name for (name,) in session.execute(select(RuleCollection.name))})
    assets = session.scalars(select(Asset).where(Asset.is_active.is_(True))).all()
    parent_names = {asset.id: asset.name for asset in assets}
    existing_schedules = {
        (s.asset_id, s.title.casefold(), s.maintenance_type)
        for s in session.scalars(
            select(MaintenanceSchedule).where(MaintenanceSchedule.status.in_(("active", "paused", "awaiting_approval")))
        )
    }
    seen_schedules: set[tuple] = set()
    start = options.maintenance_start_date or datetime.now(timezone.utc).date()

    report_items: list[dict[str, Any]] = []
    work: list[dict[str, Any]] = []
    unresolved_assets: dict[str, dict[str, Any]] = {}
    unresolved_supervisors: set[str] = set()
# Nested helper function adds an item to the report.
    def add(category, ref, name, status, *, errors=(), warnings=(), final_name=None, note=None, payload=None):
        item = {
            "category": category, "ref": ref, "name": name, "status": status,
            "final_name": final_name or name, "errors": list(errors), "warnings": list(warnings), "note": note,
        }
        report_items.append(item)
        if payload is not None:
            work.append({"item": item, **payload})
        return item
# function appilies the selected duplicate strategy -> for new name it claim new and return new. for duplicate renaming..
    def resolve_name(names: _Names, name: str):
        if not names.taken(name):
            names.claim(name)
            return "new", name, None
        if options.on_duplicate == "rename":
            final = names.unique(name)
            names.claim(final)
            return "renamed", final, f"A rule named '{name}' already exists; imported as '{final}'."
        return "duplicate", name, "A rule with this name already exists; it was left unchanged."

    # --- Monitoring rules
    for index, raw in enumerate(contents["monitoring_rules"], 1):
        ref = str(raw.get("ref") or f"MR-{index}") if isinstance(raw, dict) else f"MR-{index}"
        name = str(raw.get("name", "")) if isinstance(raw, dict) else ""
        payload, visibility, errors, warnings, unresolved = _parse_template(raw, supervisors, options, valid_ids)
        unresolved_supervisors.update(unresolved)
        if errors:
            add("monitoring_rules", ref, name, "invalid", errors=errors, warnings=warnings)
            continue
        status, final, note = resolve_name(standalone_names, payload.name)
        item = add("monitoring_rules", ref, payload.name, status, warnings=warnings, final_name=final, note=note,
                   payload=None if status == "duplicate" else {"payload": payload, "visibility": visibility})

    #  Collections (a collection with its rules is one unit)
    for index, raw in enumerate(contents["collection_rules"], 1):
        ref = str(raw.get("ref") or f"CR-{index}") if isinstance(raw, dict) else f"CR-{index}"
        if not isinstance(raw, dict):
            add("collection_rules", ref, "", "invalid", errors=["Entry must be an object."])
            continue
        name = raw.get("name")
        errors: list[str] = []
        warnings: list[str] = []
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
            errors.append("name: a collection name of 1-200 characters is required.")
        description = raw.get("description")
        labels = raw.get("labels", [])
        if description is not None and not isinstance(description, str):
            errors.append("description must be text.")
        if not isinstance(labels, list) or not all(isinstance(l, str) for l in labels) or len(labels) > 10:
            errors.append("labels must be a list of at most 10 names.")
            labels = []
        else:
            try:
                labels = normalize_label_names(labels)
            except ValueError as error:
                errors.append(f"labels: {error}")
                labels = []
        children_raw = raw.get("rules", [])
        children: list[dict[str, Any]] = []
        if not isinstance(children_raw, list) or len(children_raw) > MAX_COLLECTION_RULES:
            errors.append(f"A collection can contain at most {MAX_COLLECTION_RULES} rules.")
            children_raw = []
        child_names: set[str] = set()
        for position, child_raw in enumerate(children_raw, 1):
            payload, visibility, child_errors, child_warnings, unresolved = _parse_template(
                child_raw, supervisors, options, valid_ids)
            unresolved_supervisors.update(unresolved)
            warnings.extend(child_warnings)
            errors.extend(f"rules[{position}]: {message}" for message in child_errors)
            if payload is not None:
                if payload.name.casefold() in child_names:
                    errors.append(f"rules[{position}]: duplicate rule name '{payload.name}' in the collection.")
                child_names.add(payload.name.casefold())
                children.append({"payload": payload, "visibility": visibility})
        if errors:
            add("collection_rules", ref, str(name or ""), "invalid", errors=errors, warnings=warnings)
            continue
        status, final, note = resolve_name(collection_names, name.strip())
        add("collection_rules", ref, name.strip(), status, warnings=warnings, final_name=final, note=note,
            payload=None if status == "duplicate" else {
                "collection": {"name": final, "description": description, "labels": labels},
                "children": children,
            })
        report_items[-1]["rule_count"] = len(children)

    # --- Maintenance definitions
    for index, raw in enumerate(contents["maintenance_rules"], 1):
        ref = str(raw.get("ref") or f"MT-{index}") if isinstance(raw, dict) else f"MT-{index}"
        if not isinstance(raw, dict):
            add("maintenance_rules", ref, "", "invalid", errors=["Entry must be an object."])
            continue
        title = str(raw.get("title", ""))
        errors = []
        asset_ref = raw.get("asset")
        recurrence = raw.get("recurrence") or {}
        offset = raw.get("first_due_offset_days", 0)
        if not isinstance(asset_ref, dict) or not isinstance(asset_ref.get("name"), str) \
                or not isinstance(asset_ref.get("asset_type"), str):
            errors.append("asset: a reference with 'name' and 'asset_type' is required.")
        if not isinstance(recurrence, dict):
            errors.append("recurrence must be an object.")
            recurrence = {}
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 3650:
            errors.append("first_due_offset_days must be a whole number from 0 to 3650.")
            offset = 0
        candidate = None
        try:
            candidate = MaintenanceScheduleCreate.model_validate({
                "asset_id": 1,
                "title": raw.get("title"),
                "maintenance_type": raw.get("maintenance_type"),
                "priority": raw.get("priority", "medium"),
                "assigned_technician": raw.get("assigned_technician"),
                "description": raw.get("description"),
                "schedule_start_date": start,
                "first_due_date": start + timedelta(days=offset),
                "recurrence_enabled": bool(recurrence.get("enabled", False)),
                "recurrence_interval": recurrence.get("interval"),
                "recurrence_unit": recurrence.get("unit"),
                "instruction_document_ids": [],
            })
        except ValidationError as error:
            errors.extend(_error_text(error))
        if errors or candidate is None:
            add("maintenance_rules", ref, title, "invalid", errors=errors)
            continue
        key = _asset_key(asset_ref)
        asset_id = options.asset_mappings.get(key)
        if asset_id is not None:
            if asset_id not in parent_names:
                add("maintenance_rules", ref, candidate.title, "invalid",
                    errors=[f"The selected destination asset for '{asset_ref['name']}' does not exist or is inactive."])
                continue
        else:
            matches = [
                a for a in assets
                if a.name.casefold() == asset_ref["name"].casefold()
                and a.asset_type.casefold() == asset_ref["asset_type"].casefold()
            ]
            if len(matches) > 1 and asset_ref.get("parent_name"):
                narrowed = [a for a in matches
                            if (parent_names.get(a.parent_asset_id) or "").casefold()
                            == asset_ref["parent_name"].casefold()]
                matches = narrowed or matches
            if len(matches) == 1:
                asset_id = matches[0].id
            else:
                unresolved_assets[key] = {
                    "key": key, **{k: asset_ref.get(k) for k in ("name", "asset_type", "parent_name")},
                    "candidates": [{"id": a.id, "name": a.name, "asset_type": a.asset_type} for a in matches],
                }
                add("maintenance_rules", ref, candidate.title, "unresolved",
                    note="No single matching asset in this installation. Choose a destination asset to import it.")
                continue
        signature = (asset_id, candidate.title.casefold(), candidate.maintenance_type)
        if signature in existing_schedules or signature in seen_schedules:
            if options.on_duplicate == "rename" and signature not in seen_schedules:
                suffix = " (imported)"
                title_final = f"{candidate.title[: 200 - len(suffix)]}{suffix}"
                candidate = candidate.model_copy(update={"title": title_final})
                signature = (asset_id, title_final.casefold(), candidate.maintenance_type)
                add("maintenance_rules", ref, raw.get("title"), "renamed", final_name=title_final,
                    note=f"A matching maintenance rule exists; imported as '{title_final}'.",
                    payload={"schedule": candidate, "asset_id": asset_id})
                seen_schedules.add(signature)
                continue
            add("maintenance_rules", ref, candidate.title, "duplicate",
                note="A maintenance rule with this title, type and asset already exists; it was left unchanged.")
            continue
        seen_schedules.add(signature)
        add("maintenance_rules", ref, candidate.title, "new",
            payload={"schedule": candidate, "asset_id": asset_id})

    counts = {c: {"new": 0, "renamed": 0, "duplicate": 0, "unresolved": 0, "invalid": 0} for c in CATEGORIES}
    for item in report_items:
        counts[item["category"]][item["status"]] += 1
    invalid = sum(c["invalid"] for c in counts.values())
    importable = sum(c["new"] + c["renamed"] for c in counts.values())
    can_import = importable > 0 and (invalid == 0 or options.skip_invalid)
    return {
        "package": {
            "application": package.get("application"),
            "format_version": package.get("format_version"),
            "exported_at": package.get("exported_at"),
        },
        "options": options.model_dump(mode="json"),
        "items": report_items,
        "counts": counts,
        "totals": {
            "to_import": importable,
            "duplicates": sum(c["duplicate"] for c in counts.values()),
            "unresolved": sum(c["unresolved"] for c in counts.values()),
            "invalid": invalid,
        },
        "unresolved_assets": list(unresolved_assets.values()),
        "unresolved_supervisors": sorted(unresolved_supervisors),
        "can_import": can_import,
        "_work": work,
    }


#  apply
# Actual db creation -> this creates a real MonitoringRuleTemplate record.
def _create_template(session, admin, payload, visibility, collection_id, import_id_ref):
    values = payload.model_dump(exclude={"labels"})
    values["collection_id"] = collection_id
    template = MonitoringRuleTemplate(**values, visibility_type="admin_only")
    session.add(template)
    session.flush()
    assign_labels(session, template, payload.labels)
    vis_type, supervisor_ids = visibility
    if vis_type == "specific_supervisors":
        apply_visibility(session, template, vis_type, supervisor_ids, actor=admin, source="import")
    session.add(RuleTemplateChange(
        template_id=template.id,
        changed_by_id=admin.id,
        field="import",
        previous_value=None,
        new_value={"imported": True, "import_ref": import_id_ref, "visibility": vis_type},
    ))
    return template

# Actual import operation
def apply_import(session: Session, package: Any, options: ImportOptions, admin: User) -> dict[str, Any]:
    # Create the validated records inside the caller's transaction and commit once at the end.
    from app.api.routes.maintenance import _create_maintenance_schedule

    report = analyse(session, package, options)
    if report["totals"]["invalid"] and not options.skip_invalid:
        problems = [
            f"{i['category']} {i['ref']} ({i['name'] or 'unnamed'}): " + "; ".join(i["errors"])
            for i in report["items"] if i["status"] == "invalid"
        ]
        raise HTTPException(status_code=422, detail="The file contains invalid entries. Nothing was imported. " + " | ".join(problems[:10]),)
    if not report["can_import"]:
        raise HTTPException(status_code=422,detail="There is nothing to import: every entry is a duplicate, unresolved or invalid.",)
    work = report.pop("_work")
    try:
        log = ConfigurationImport(
            imported_by_id=admin.id,
            source_application=str(package.get("application"))[:100],
            source_format_version=str(package.get("format_version"))[:20],
            source_exported_at=str(package.get("exported_at") or "")[:40] or None,
            duplicate_strategy=options.on_duplicate,
            summary={}, items=[],
        )
        session.add(log)
        session.flush()
        created: list[dict[str, Any]] = []
        for entry in work:
            item = entry["item"]
            ref = f"{item['category']}:{item['ref']}"
            if "schedule" in entry:
                schedule = _create_maintenance_schedule(
                    session, entry["schedule"].model_copy(update={"asset_id": entry["asset_id"]}))
                created.append({"category": item["category"], "name": item["final_name"], "id": schedule.id})
            elif "collection" in entry:
                spec = entry["collection"]
                collection = RuleCollection(name=spec["name"], description=spec["description"])
                session.add(collection)
                session.flush()
                assign_labels(session, collection, spec["labels"])
                for child in entry["children"]:
                    _create_template(session, admin, child["payload"], child["visibility"], collection.id, ref)
                created.append({"category": item["category"], "name": item["final_name"], "id": collection.id})
            else:
                template = _create_template(
                    session, admin, entry["payload"], entry["visibility"], None, ref)
                if item["final_name"] != entry["payload"].name:
                    template.name = item["final_name"]
                created.append({"category": item["category"], "name": item["final_name"], "id": template.id})
            item["status"] = "imported"
        summary = {
            "imported": len(created),
            "duplicates": report["totals"]["duplicates"],
            "unresolved": report["totals"]["unresolved"],
            "failed": report["totals"]["invalid"],
        }
        log.summary = summary
        log.items = [
            {"category": i["category"], "name": i["final_name"], "status": i["status"]}
            for i in report["items"]
        ]
        session.commit()
    except Exception:
        session.rollback()
        raise
    report["summary"] = summary
    report["import_id"] = log.id
    report["created"] = created
    report["can_import"] = False
    return report
