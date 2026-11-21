# Instruction-document storage location, stored-file path checks and reference scanning (used before a document or its last file is deleted).
from __future__ import annotations
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    InstructionDocumentFile,
    MaintenanceSchedule,
    MonitoringRule,
    MonitoringRuleTemplate,
    MonitoringRuleTemplateRequest,
)

UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads" / "instruction_documents"

def _lists_document(ids: Any, document_id: int) -> bool:
    return isinstance(ids, (list, tuple)) and any(
        isinstance(item, int) and not isinstance(item, bool) and item == document_id for item in ids)

# Every place that stores this document's id. Document links live in JSON columns (no foreign key), so each is scanned.
def document_references(session: Session, document_id: int) -> list[dict[str, Any]]:
    references: list[dict[str, Any]] = []
    for rule_id, name, asset_id, parameters in session.execute(
            select(MonitoringRule.id, MonitoringRule.name, MonitoringRule.target_asset_id, MonitoringRule.parameters)):
        if _lists_document((parameters or {}).get("document_ids"), document_id):
            references.append({"type": "monitoring_rule", "id": rule_id, "name": name, "asset_id": asset_id})
    for template_id, name, parameters in session.execute(
            select(MonitoringRuleTemplate.id, MonitoringRuleTemplate.name, MonitoringRuleTemplate.parameters)):
        if _lists_document((parameters or {}).get("document_ids"), document_id):
            references.append({"type": "shared_rule", "id": template_id, "name": name, "asset_id": None})
    for schedule_id, title, asset_id, ids in session.execute(
            select(MaintenanceSchedule.id, MaintenanceSchedule.title, MaintenanceSchedule.asset_id,
                   MaintenanceSchedule.instruction_document_ids)):
        if _lists_document(ids, document_id):
            references.append({"type": "maintenance_schedule", "id": schedule_id, "name": title, "asset_id": asset_id})
    for request_id, name, details in session.execute(
            select(MonitoringRuleTemplateRequest.id, MonitoringRuleTemplateRequest.name,
                   MonitoringRuleTemplateRequest.maintenance_details)):
        if _lists_document((details or {}).get("instruction_document_ids"), document_id):
            references.append({"type": "rule_request", "id": request_id, "name": name, "asset_id": None})
    return references

def stored_file_available(attachment: InstructionDocumentFile) -> bool:
    try:
        stored_instruction_file_path(attachment)
    except HTTPException:
        return False
    return True

def stored_instruction_file_path(attachment: InstructionDocumentFile) -> Path:
    stored_name = attachment.stored_name
    if (
        not stored_name
        or stored_name in {".", ".."}
        or "/" in stored_name
        or "\\" in stored_name
        or Path(stored_name).is_absolute()
        or bool(Path(stored_name).drive)
        or Path(stored_name).name != stored_name
    ):
        raise HTTPException(status_code=404, detail="Stored file is missing")

    upload_root = UPLOAD_DIR.resolve()
    try:
        path = (upload_root / stored_name).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=404, detail="Stored file is missing") from error
    if path.parent != upload_root or not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file is missing")
    return path
