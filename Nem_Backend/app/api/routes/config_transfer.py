"""Administrator-only export / import of reusable configuration packages.

The only endpoints that expose or accept a configuration package. Every handler re-checks the
Administrator role (the middleware also gates the ``/config-transfer`` prefix).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.config_transfer import CATEGORIES, ImportRequest, analyse, apply_import, build_export, export_summary
from app.services.rule_visibility import require_session_roles

router = APIRouter(prefix="/config-transfer", tags=["configuration transfer"])
logger = logging.getLogger(__name__)

# This function filters the response dictionary , remove dictionary whose keys start with an underscore.
def _public(report: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in report.items() if not key.startswith("_")}

# This endpoint downloads the config. package as JSON response.
@router.get("/export")
def export_configuration(
    categories: str | None = Query(default=None, description="Comma-separated categories; default all"),
    asset_ids: str | None = Query(default=None, description="Comma-separated asset ids limiting maintenance rules"),
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    admin = require_session_roles(session, "Administrator")
    selected = None
    if categories is not None:
        selected = tuple(dict.fromkeys(part.strip() for part in categories.split(",") if part.strip()))
        unknown = [name for name in selected if name not in CATEGORIES]
        if not selected or unknown:
            raise HTTPException(status_code=422, detail="Unknown or empty export category.")
    asset_filter = None
    if asset_ids is not None:
        try:
            asset_filter = {int(part) for part in asset_ids.split(",") if part.strip()}
        except ValueError:
            raise HTTPException(status_code=422, detail="asset_ids must be comma-separated numbers.") from None
    package = build_export(session, selected, asset_filter)
    # Exports leave the system, so each one is recorded (who, what, how much); no content is logged.
    logger.info(
        "Configuration export by user_id=%s categories=%s counts=%s",
        admin.id,
        list(package["contents"]),
        {name: len(items) for name, items in package["contents"].items()},
    )
    return package

# Counts shown before downloading (read-only).
@router.get("/export/summary")
def export_preview(session: Session = Depends(get_db)) -> dict[str, Any]:
    require_session_roles(session, "Administrator")
    return export_summary(session)

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
