"""Administrator-only export / import of reusable configuration packages.

The only endpoints that expose or accept a configuration package. Every handler re-checks the
Administrator role (the middleware also gates the ``/config-transfer`` prefix).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.config_transfer import ImportRequest, analyse, apply_import, build_export
from app.services.rule_visibility import require_session_roles

router = APIRouter(prefix="/config-transfer", tags=["configuration transfer"])

# This function filters the response dictionary , remove dictionary whose keys start with an underscore.
def _public(report: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in report.items() if not key.startswith("_")}

# This endpoint downloads the config. package as JSON response.
@router.get("/export")
def export_configuration(session: Session = Depends(get_db)) -> dict[str, Any]:
    require_session_roles(session, "Administrator")
    return build_export(session)

# Validation stage -> 
@router.post("/preview")
def preview_import(payload: ImportRequest, session: Session = Depends(get_db)) -> dict[str, Any]:
    # Validate a package and report what an import would do. Writes nothing
    require_session_roles(session, "Administrator")
    return _public(analyse(session, payload.package, payload))

# Actual import endpoint -> this is where the actual db records are created. 
@router.post("/import", status_code=201)
def import_configuration(payload: ImportRequest, session: Session = Depends(get_db)) -> dict[str, Any]:
    # Re-validate and import a package in one transaction (all or nothing).
    admin = require_session_roles(session, "Administrator")
    return _public(apply_import(session, payload.package, payload, admin))
