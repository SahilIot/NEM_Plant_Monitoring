import json
import os
import tempfile
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, insert, inspect as sa_inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.session import UTCDateTime
from app.models import (
    Alert,
    Asset,
    FrontendConfig,
    InstructionDocument,
    MaintenanceRecord,
    MonitoringEvent,
    MonitoringRule,
    MonitoringRuleTemplate,
    Reading,
    RuleCollection,
    RuleState,
    Variable,
)

SNAPSHOT_MODELS = (
    Asset,
    Variable,
    Reading,
    MonitoringRuleTemplate,
    MonitoringRule,
    RuleState,
    Alert,
    MonitoringEvent,
    MaintenanceRecord,
    FrontendConfig,
    RuleCollection,
    InstructionDocument,
)
DELETE_ORDER = tuple(reversed(SNAPSHOT_MODELS))


def backup_directory(settings: Settings) -> Path:
    configured = Path(settings.backup_directory)
    directory = configured if configured.is_absolute() else Path(__file__).resolve().parents[2] / configured
    directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve()


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"__datetime__": value.isoformat()}
    if isinstance(value, date):
        return {"__date__": value.isoformat()}
    if isinstance(value, Decimal):
        return {"__decimal__": str(value)}
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Unsupported value in database backup: {type(value).__name__}")


def _json_object_hook(value: dict[str, Any]) -> Any:
    if set(value) == {"__datetime__"}:
        return datetime.fromisoformat(value["__datetime__"])
    if set(value) == {"__date__"}:
        return date.fromisoformat(value["__date__"])
    if set(value) == {"__decimal__"}:
        return Decimal(value["__decimal__"])
    return value


def _attribute_keys(model: Any) -> dict[str, str]:
    mapper = sa_inspect(model)
    return {
        column.name: mapper.get_property_by_column(column).key
        for column in model.__table__.columns
    }


def create_backup(session: Session, settings: Settings, name: str, note: str | None):
    from app.models import BackupRecord

    filename = f"{uuid4().hex}.json"
    target = backup_directory(settings) / filename
    content = {}
    for model in SNAPSHOT_MODELS:
        keys = _attribute_keys(model)
        rows = session.query(model).order_by(model.__table__.primary_key.columns.values()[0]).all()
        content[model.__tablename__] = [
            {column_name: getattr(row, attribute) for column_name, attribute in keys.items()}
            for row in rows
        ]
    encoded = json.dumps(content, default=_json_default, separators=(",", ":"))
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=target.parent, delete=False
        ) as temporary:
            temporary.write(encoded)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, target)
    except OSError as error:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not write database backup file") from error

    record = BackupRecord(name=name, note=note, file_name=filename)
    session.add(record)
    try:
        session.commit()
    except Exception:
        target.unlink(missing_ok=True)
        raise
    session.refresh(record)
    return record


def restore_backup(
    session: Session,
    engine: Engine,
    settings: Settings,
    filename: str,
) -> None:
    if Path(filename).name != filename or not filename.endswith(".json"):
        raise HTTPException(status_code=422, detail="Invalid backup filename")
    target = backup_directory(settings) / filename
    try:
        content = json.loads(target.read_text(encoding="utf-8"), object_hook=_json_object_hook)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Backup file was not found") from error
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="Backup file could not be read") from error
    if not isinstance(content, dict):
        raise HTTPException(status_code=422, detail="Backup file has an invalid format")
    content.setdefault(MonitoringRuleTemplate.__tablename__, [])
    if any(
        not isinstance(content.get(model.__tablename__), list) for model in SNAPSHOT_MODELS
    ):
        raise HTTPException(status_code=422, detail="Backup file has an invalid format")

    try:
        for model in DELETE_ORDER:
            session.execute(delete(model))
        for model in SNAPSHOT_MODELS:
            allowed_columns = {column.name for column in model.__table__.columns}
            rows = content[model.__tablename__]
            if any(not isinstance(row, dict) or set(row) - allowed_columns for row in rows):
                raise HTTPException(status_code=422, detail="Backup file contains invalid table data")
            if rows:
                session.execute(insert(model.__table__), rows)
        if engine.dialect.name == "postgresql":
            for model in SNAPSHOT_MODELS:
                if "id" in model.__table__.columns:
                    table_name = model.__table__.name.replace("'", "''")
                    session.execute(
                        text(
                            "SELECT setval(pg_get_serial_sequence(:table_name, 'id'), "
                            f'COALESCE((SELECT MAX(id) FROM "{table_name}"), 1), '
                            f'EXISTS(SELECT 1 FROM "{table_name}"))'
                        ),
                        {"table_name": model.__table__.name},
                    )
        session.commit()
        from app.db.init_db import _migrate_legacy_rule_templates

        _migrate_legacy_rule_templates(engine)
    except Exception:
        session.rollback()
        raise