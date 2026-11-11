"""Database backup and restore (dashboard data).

A backup is one ZIP archive (format version 2) written from a single PostgreSQL REPEATABLE READ
snapshot, so every table shows the same moment in time:

    manifest.json                    format, version, row counts, SHA-256 of every member
    tables/<table>.jsonl             one JSON object per row, ordered by primary key
    files/<stored_name>              the uploaded document attachments referenced by the backup

Older backups (format version 1) are a single ``.json`` file holding thirteen tables; they can still be
restored (see ``_LegacySource``).

Restore is a full replacement of the tables in scope, in two steps. ``analyze_restore`` validates the whole
archive and reports the impact (including rows OUTSIDE the backup that foreign keys would delete or
change) without touching anything, and issues a signed confirmation bound to that backup and that exact
impact. ``restore_backup`` validates again, stages the attachments, and then runs all deletes, inserts and
sequence resets in ONE database transaction on its own connection (never the caller's session): the impact
is recomputed under exclusive locks and must still match the confirmation, otherwise the restore is refused;
any failure rolls back and leaves the data untouched. Files are moved into the upload folder only after the
commit, and existing upload files are never overwritten or deleted.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import shutil
import tempfile
import time
import zipfile
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Float, Integer, JSON, Numeric, SmallInteger, String, Uuid,
    bindparam, delete, func, insert, select, text,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.types import TypeDecorator, TypeEngine

from app.core.config import Settings
from app.db.base import Base
from app.models import (
    Alert,
    Asset,
    AssetSupervisor,
    FrontendConfig,
    InstructionDocument,
    InstructionDocumentFile,
    Label,
    MachineMonitoringState,
    MaintenanceRecord,
    MaintenanceSchedule,
    MonitoringEvent,
    MonitoringRule,
    MonitoringRuleTemplate,
    Reading,
    RuleCollection,
    RuleCounterState,
    RuleState,
    Variable,
)
from app.models.labels import instruction_document_labels, rule_collection_labels, rule_labels, rule_template_labels
from app.models.rule_visibility import (
    RuleTemplateChange,
    RuleVisibilityChange,
    rule_template_visibility_supervisors,
)

logger = logging.getLogger(__name__)

FORMAT_NAME = "nem-database-backup"
FORMAT_VERSION = 2

# Tables of format version 1 (what older backups contain). Kept under its historic name.
SNAPSHOT_MODELS = (
    Asset,
    Variable,
    Reading,
    MonitoringRuleTemplate,
    MonitoringRule,
    RuleCounterState,
    RuleState,
    Alert,
    MonitoringEvent,
    MaintenanceRecord,
    FrontendConfig,
    RuleCollection,
    InstructionDocument,
)
_LEGACY_TABLE_NAMES = tuple(model.__tablename__ for model in SNAPSHOT_MODELS)
# Absent from very old version-1 files; restored as empty then.
_LEGACY_OPTIONAL = frozenset({MonitoringRuleTemplate.__tablename__, RuleCounterState.__tablename__})

# Everything a version-2 backup replaces. Besides the version-1 tables this adds the tables that either
# block deleting an asset (maintenance schedules and machine states reference assets with RESTRICT) or
# are silently removed by ON DELETE CASCADE when their parent is replaced (labels and label links, document
# attachment metadata, asset supervisor assignments, shared-rule history and visibility grants).
_SCOPE_TABLES = frozenset(
    {model.__table__ for model in SNAPSHOT_MODELS}
    | {model.__table__ for model in (
        MaintenanceSchedule, MachineMonitoringState, InstructionDocumentFile, Label, AssetSupervisor,
        RuleTemplateChange, RuleVisibilityChange,
    )}
    | {rule_labels, rule_template_labels, rule_collection_labels, instruction_document_labels,
       rule_template_visibility_supervisors}
)
# Tables that are deliberately NOT backed up: users and sessions (accounts are not part of the backup),
# rule suggestions, configuration-import log, email outbox (replaying queued emails for restored alerts
# would be wrong), scheduler leases and the backup history itself.

_BATCH = 1000
_MAX_LINE_BYTES = 16 * 1024 * 1024
_MAX_MANIFEST_BYTES = 32 * 1024 * 1024
_MAX_LEGACY_BYTES = 512 * 1024 * 1024
_MAX_ARCHIVE_UNCOMPRESSED = 64 * 1024 * 1024 * 1024  # deliberate operational ceiling against decompression bombs
_ALLOWED_ATTACHMENT_SUFFIXES = (".pdf", ".doc", ".docx", ".txt")
_SAFE_STORED_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,90}\.[A-Za-z0-9]{1,8}$")
_SAFE_BACKUP_NAME = re.compile(r"^[A-Za-z0-9_-]{1,100}\.(json|zip)$")
_RESTORE_LOCK_KEY = 727001  # PostgreSQL advisory lock: only one restore at a time, across all workers
_LOCK_TIMEOUT = "20s"
_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
_CONFIRMATION_TTL_SECONDS = 15 * 60
_RECOVERY_NAME = re.compile(r"^restore-recovery-[0-9a-f]{12}$")

DOCUMENT_UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads" / "instruction_documents"


class BackupError(Exception):
    # The backup is unreadable, incomplete or inconsistent. Nothing has been changed.
    pass

# Backup creation and restore validation both use this module-level table ordering.
def _ordered_tables(names: set[str] | None = None) -> list:
    # Parents before children, computed from the foreign keys declared on the models.
    return [
        table for table in Base.metadata.sorted_tables
        if table in _SCOPE_TABLES and (names is None or table.name in names)
    ]


def backup_directory(settings: Settings) -> Path:
    configured = Path(settings.backup_directory)
    directory = configured if configured.is_absolute() else Path(__file__).resolve().parents[2] / configured
    directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve()


# Column handling
def _unwrap(column_type: TypeEngine) -> TypeEngine:
    while isinstance(column_type, TypeDecorator):
        inner = column_type.impl
        column_type = inner() if isinstance(inner, type) else inner
    return column_type


def _kind(column) -> str:
    inner = _unwrap(column.type)
    if isinstance(inner, Boolean):
        return "bool"
    if isinstance(inner, Integer):
        return "int"
    if isinstance(inner, Float):
        return "float"
    if isinstance(inner, Numeric):
        return "decimal"
    if isinstance(inner, DateTime):
        return "datetime"
    if isinstance(inner, Date):
        return "date"
    if isinstance(inner, JSON):
        return "json"
    if isinstance(inner, Uuid):
        return "uuid"
    if isinstance(inner, String):
        return "str"
    raise BackupError(f"Column {column.table.name}.{column.name} has an unsupported type ({inner.__class__.__name__}).")


def _encode(value: Any, kind: str, where: str) -> Any:
    if value is None:
        return None
    if kind == "datetime":
        if not isinstance(value, datetime):
            raise BackupError(f"{where}: expected a datetime.")
        return value.isoformat()
    if kind == "date":
        return value.isoformat()
    if kind == "decimal":
        return str(value if isinstance(value, Decimal) else Decimal(str(value)))
    if kind == "float":
        if isinstance(value, float) and value != value or value in (float("inf"), float("-inf")):
            raise BackupError(f"{where}: NaN/infinite numbers cannot be stored in a backup.")
        return value
    if kind == "uuid":
        return str(value)
    if kind in ("int", "bool", "str", "json"):
        return value
    raise BackupError(f"{where}: unsupported value.")


def _marker(value: Any, key: str) -> Any:
    # Version-1 files wrap datetime/date/Decimal cells as {"__datetime__": ...}. They are recognised only
    # for columns of that type, never inside JSON columns.
    if isinstance(value, dict) and set(value) == {key}:
        return value[key]
    return value


def _decode(value: Any, column, kind: str, where: str) -> Any:
    if value is None:
        if not column.nullable:
            raise BackupError(f"{where}: a value is required.")
        return None
    if kind == "bool":
        if not isinstance(value, bool):
            raise BackupError(f"{where}: expected true or false.")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise BackupError(f"{where}: expected a whole number.")
        inner = _unwrap(column.type)  # SmallInteger, Integer and BigInteger have different PostgreSQL ranges
        bits = 63 if isinstance(inner, BigInteger) else 15 if isinstance(inner, SmallInteger) else 31
        if not -(2 ** bits) <= value < 2 ** bits:
            raise BackupError(f"{where}: {value} is outside the range of the column.")
        return value
    if kind == "uuid":
        if not isinstance(value, str):
            raise BackupError(f"{where}: expected a UUID.")
        try:
            parsed = UUID(value)
        except ValueError as error:
            raise BackupError(f"{where}: {value!r} is not a valid UUID.") from error
        return parsed if getattr(_unwrap(column.type), "as_uuid", True) else str(parsed)
    if kind == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise BackupError(f"{where}: expected a number.")
        try:
            number = float(value)
        except OverflowError as error:
            raise BackupError(f"{where}: number is too large.") from error
        if not math.isfinite(number):
            raise BackupError(f"{where}: number is not finite (too large to store).")
        return number
    if kind == "str":
        if not isinstance(value, str):
            raise BackupError(f"{where}: expected text.")
        if "\x00" in value:
            raise BackupError(f"{where}: text contains a NUL character.")
        limit = getattr(_unwrap(column.type), "length", None)
        if limit and len(value) > limit:
            raise BackupError(f"{where}: text is longer than {limit} characters.")
        return value
    if kind == "decimal":
        raw = _marker(value, "__decimal__")
        if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
            raise BackupError(f"{where}: expected a decimal number.")
        try:
            number = Decimal(str(raw))
        except InvalidOperation as error:
            raise BackupError(f"{where}: {raw!r} is not a valid decimal number.") from error
        if not number.is_finite():
            raise BackupError(f"{where}: decimal value is not finite.")
        inner = _unwrap(column.type)
        precision, scale = getattr(inner, "precision", None), getattr(inner, "scale", None)
        if precision is not None:
            _check_numeric_fit(number, precision, scale or 0, where, raw)
        return number
    if kind == "datetime":
        raw = _marker(value, "__datetime__")
        if not isinstance(raw, str):
            raise BackupError(f"{where}: expected a date and time.")
        try:
            return datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
        except ValueError as error:
            raise BackupError(f"{where}: {raw!r} is not a valid date and time.") from error
    if kind == "date":
        raw = _marker(value, "__date__")
        if not isinstance(raw, str):
            raise BackupError(f"{where}: expected a date.")
        try:
            return date.fromisoformat(raw)
        except ValueError as error:
            raise BackupError(f"{where}: {raw!r} is not a valid date.") from error
    return value  # json: kept exactly as stored


def _check_numeric_fit(number: Decimal, precision: int, scale: int, where: str, raw: Any) -> None:
    # Exact check on the Decimal tuple (independent of the decimal context): PostgreSQL would silently round
    # extra decimal places and reject too many integer digits, so both are refused here.
    _sign, digits, exponent = number.as_tuple()
    digits = list(digits)
    while exponent < 0 and len(digits) > 1 and digits[-1] == 0:  # trailing zeros are harmless: 12.340 == 12.34
        digits.pop()
        exponent += 1
    if digits == [0]:
        return
    if max(-exponent, 0) > scale:
        raise BackupError(f"{where}: {raw!r} has more than {scale} decimal places (NUMERIC({precision},{scale})); it would be rounded.")
    if max(len(digits) + exponent, 0) > precision - scale:
        raise BackupError(f"{where}: {raw!r} does not fit NUMERIC({precision},{scale}).")


def _json_line(row: dict[str, Any]) -> bytes:
    return (json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


# Creating a backup

def _write_archive(engine: Engine, path: Path) -> dict[str, Any]:
    tables = _ordered_tables() # type: ignore
    manifest: dict[str, Any] = {
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "snapshot": "postgresql REPEATABLE READ",
        "tables": {},
        "files": {},
        "missing_files": [],
        "inconsistent_files": [],
        "missing_details": [],
        "inconsistent_details": [],
    }
    stored_names: dict[str, tuple[int, Any, str]] = {}  # stored name -> (recorded size, document id, original name)
    # One snapshot for every table: the transaction keeps seeing the database as it was when it started,
    # whatever other users commit while the (possibly long) export runs. Read-only, so it blocks nobody.
    connection = engine.connect().execution_options(isolation_level="REPEATABLE READ", postgresql_readonly=True)
    try:
        with connection.begin(), zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for table in tables:
                columns = list(table.columns)
                kinds = {column.name: _kind(column) for column in columns}
                order = list(table.primary_key.columns) or [columns[0]]
                statement = select(table).order_by(*order).execution_options(stream_results=True, yield_per=_BATCH)
                digest, count = hashlib.sha256(), 0
                with archive.open(f"tables/{table.name}.jsonl", "w", force_zip64=True) as member:
                    for chunk in connection.execute(statement).partitions():
                        for row in chunk:
                            mapping = row._mapping
                            encoded = _json_line({
                                column.name: _encode(mapping[column.name], kinds[column.name], f"{table.name}.{column.name}")
                                for column in columns
                            })
                            member.write(encoded)
                            digest.update(encoded)
                            count += 1
                            if table is InstructionDocumentFile.__table__:
                                stored_names[mapping["stored_name"]] = (
                                    mapping["size_bytes"], mapping["document_id"], mapping["original_name"],
                                )
                manifest["tables"][table.name] = {
                    "rows": count, "sha256": digest.hexdigest(), "columns": [column.name for column in columns],
                }
            # The files are copied after the rows; rows and files may therefore differ if a file is removed
            # meanwhile, which is reported as a missing file rather than hidden.
            for stored_name, (recorded_size, document_id, original_name) in stored_names.items():
                source = DOCUMENT_UPLOAD_DIR / stored_name
                detail = {"stored_name": stored_name, "document_id": document_id, "original_name": original_name}
                if not _SAFE_STORED_NAME.match(stored_name) or not source.is_file():
                    manifest["missing_files"].append(stored_name)
                    manifest["missing_details"].append(detail)
                    continue
                digest, size = hashlib.sha256(), 0
                with source.open("rb") as handle, archive.open(f"files/{stored_name}", "w", force_zip64=True) as member:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        member.write(block)
                        digest.update(block)
                        size += len(block)
                manifest["files"][stored_name] = {"size": size, "sha256": digest.hexdigest()}
                if size != recorded_size:
                    manifest["inconsistent_files"].append(stored_name)
                    manifest["inconsistent_details"].append({**detail, "recorded_size": recorded_size, "actual_size": size})
            archive.writestr("manifest.json", json.dumps(manifest, indent=1))
    finally:
        connection.close()
    return manifest


def _describe_documents(details: list[dict[str, Any]], limit: int = 10) -> str:
    shown = [f"document {item['document_id']} \"{item['original_name']}\" ({item['stored_name']})" for item in details[:limit]]
    more = len(details) - limit
    return "; ".join(shown) + (f"; and {more} more" if more > 0 else "")


def create_backup_with_report(session: Session, settings: Settings, name: str, note: str | None):
    # Create a backup; returns (BackupRecord, report) where the report lists tables, files and warnings.
    from app.models import BackupRecord

    bind = session.get_bind()
    engine = bind.engine if isinstance(bind, Connection) else bind
    filename = f"{uuid4().hex}.zip"
    directory = backup_directory(settings)
    target = directory / filename
    temporary: Path | None = None
    _remove_stale_work_files(directory, ".backup-*.tmp")
    try:
        handle, temporary_name = tempfile.mkstemp(dir=directory, prefix=".backup-", suffix=".tmp")
        os.close(handle)
        temporary = Path(temporary_name)
        manifest = _write_archive(engine, temporary)
        os.replace(temporary, target)
        temporary = None
    except BackupError as error:
        raise HTTPException(status_code=500, detail=f"Could not create the database backup: {error}") from error
    except (OSError, SQLAlchemyError) as error:
        logger.exception("Database backup failed")
        raise HTTPException(status_code=500, detail="Could not create the database backup. Nothing was saved.") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    # The history row is written with its OWN session and transaction: the caller's session is never committed,
    # rolled back or flushed here, so unrelated pending changes in it can neither be saved nor lost by a backup.
    try:
        with Session(engine, expire_on_commit=False) as own:
            record = BackupRecord(name=name, note=note, file_name=filename)
            own.add(record)
            own.commit()
            own.refresh(record)
            own.expunge(record)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    warnings = []
    if manifest["missing_details"]:
        warnings.append(
            "Attachment file(s) listed in the database were not found on disk and are not in this backup: "
            + _describe_documents(manifest["missing_details"]) + "."
        )
    if manifest["inconsistent_details"]:
        warnings.append(
            "Attachment file(s) differ in size from the size recorded in the database (saved as found): "
            + _describe_documents(manifest["inconsistent_details"]) + "."
        )
    report = {
        "format_version": FORMAT_VERSION,
        "rows": {table: info["rows"] for table, info in manifest["tables"].items()},
        "files": len(manifest["files"]),
        "warnings": warnings,
    }
    return record, report


# Reading a backup
class _Source:
    version = 0
    ordered = False

    def table_names(self) -> set[str]:
        raise NotImplementedError

    def rows(self, table) -> Iterator[dict[str, Any]]:
        raise NotImplementedError

    def file_info(self) -> dict[str, dict[str, Any]]:
        return {}

    def missing_files(self) -> set[str]:
        return set()

    def stage_file(self, name: str, destination: Path) -> None:
        raise BackupError("This backup does not contain attachment files.")

    def close(self) -> None:
        pass


class _LegacySource(_Source):
    # Format version 1: one JSON object, table name -> list of rows.

    version = 1

    def __init__(self, path: Path):
        try:
            size = path.stat().st_size
            if size > _MAX_LEGACY_BYTES:
                raise BackupError("The backup file is too large to restore (limit 512 MB for the old format).")
            # No object hook: cells are decoded per column type, so application JSON that merely looks like
            # a date/Decimal marker is never rewritten.
            content = json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject_constant)
        except BackupError:
            raise
        except (UnicodeDecodeError, ValueError) as error:
            raise BackupError("The backup file is not valid JSON.") from error
        except RecursionError as error:
            raise BackupError("The backup file is nested too deeply.") from error
        except MemoryError as error:
            raise BackupError("The backup file is too large to restore.") from error
        if not isinstance(content, dict):
            raise BackupError("The backup file has an invalid format (expected a JSON object).")
        if "format_version" in content or "format" in content:
            raise BackupError("The backup file has an unrecognised format.")
        self.content = content

    def table_names(self) -> set[str]:
        return set(self.content)

    def rows(self, table):
        value = self.content.get(table.name, [])
        if not isinstance(value, list):
            raise BackupError(f"Table {table.name} must be a list of rows.")
        yield from value


class _ZipSource(_Source):
    version = FORMAT_VERSION
    ordered = True

    def __init__(self, path: Path):
        try:
            self.archive = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as error:
            raise BackupError("The backup archive is not a valid ZIP file.") from error
        try:
            infos = {info.filename: info for info in self.archive.infolist()}
            if len(infos) != len(self.archive.infolist()):
                raise BackupError("The backup archive contains duplicate entries.")
            if sum(info.file_size for info in infos.values()) > _MAX_ARCHIVE_UNCOMPRESSED:
                raise BackupError("The backup archive is larger than the supported size.")
            manifest_info = infos.get("manifest.json")
            if manifest_info is None:
                raise BackupError("The backup archive has no manifest.")
            if manifest_info.file_size > _MAX_MANIFEST_BYTES:
                raise BackupError("The backup manifest is too large.")
            try:
                manifest = json.loads(self.archive.read(manifest_info), parse_constant=_reject_constant)
            except (ValueError, zipfile.BadZipFile) as error:
                raise BackupError("The backup manifest is not valid JSON.") from error
            self.infos = infos
            self.manifest = self._check_manifest(manifest)
        except Exception:
            self.archive.close()
            raise

    def _check_manifest(self, manifest: Any) -> dict[str, Any]:
        if not isinstance(manifest, dict) or manifest.get("format") != FORMAT_NAME:
            raise BackupError("This is not a NEM database backup.")
        version = manifest.get("format_version")
        if isinstance(version, bool) or not isinstance(version, int):
            raise BackupError("The backup format version is missing or invalid.")
        if version > FORMAT_VERSION:
            raise BackupError(
                f"This backup uses format version {version}, which is newer than this application supports "
                f"({FORMAT_VERSION}). Update NEM before restoring it."
            )
        if version < 2:
            raise BackupError("The backup manifest declares an unsupported format version.")
        tables, files, missing = manifest.get("tables"), manifest.get("files"), manifest.get("missing_files", [])
        if not isinstance(tables, dict) or not isinstance(files, dict) or not isinstance(missing, list):
            raise BackupError("The backup manifest is malformed.")
        for name, info in tables.items():
            if not isinstance(info, dict) or not _count(info.get("rows")) or not _SHA256.match(str(info.get("sha256"))):
                raise BackupError(f"The manifest entry for table {name} is malformed.")
            if f"tables/{name}.jsonl" not in self.infos:
                raise BackupError(f"Table {name} is listed in the manifest but missing from the archive.")
        for name, info in files.items():
            if not _SAFE_STORED_NAME.match(name) or not isinstance(info, dict) \
                    or not _count(info.get("size")) or not _SHA256.match(str(info.get("sha256"))):
                raise BackupError("The manifest lists an invalid attachment entry.")
            if f"files/{name}" not in self.infos:
                raise BackupError(f"Attachment {name} is listed in the manifest but missing from the archive.")
        if not all(isinstance(item, str) for item in missing):
            raise BackupError("The backup manifest is malformed.")
        allowed = {"manifest.json"} | {f"tables/{n}.jsonl" for n in tables} | {f"files/{n}" for n in files}
        stray = sorted(set(self.infos) - allowed)
        if stray:
            raise BackupError(f"The backup archive contains unexpected entries (for example {stray[0]!r}).")
        return manifest

    def table_names(self) -> set[str]:
        return set(self.manifest["tables"])

    def file_info(self):
        return self.manifest["files"]

    def missing_files(self):
        return set(self.manifest.get("missing_files", []))

    def rows(self, table):
        info = self.manifest["tables"][table.name]
        digest, count = hashlib.sha256(), 0
        with self.archive.open(f"tables/{table.name}.jsonl") as member:
            while True:
                line = member.readline(_MAX_LINE_BYTES + 1)
                if not line:
                    break
                if len(line) > _MAX_LINE_BYTES or not line.endswith(b"\n"):
                    raise BackupError(f"Table {table.name}: a row is too long or the file is truncated.")
                digest.update(line)
                count += 1
                try:
                    yield json.loads(line, parse_constant=_reject_constant)
                except ValueError as error:
                    raise BackupError(f"Table {table.name}, row {count}: not valid JSON.") from error
        if count != info["rows"] or digest.hexdigest() != info["sha256"]:
            raise BackupError(f"Table {table.name} does not match the manifest (the backup is corrupted or was modified).")

    def stage_file(self, name: str, destination: Path) -> None:
        info = self.manifest["files"][name]
        digest, size = hashlib.sha256(), 0
        with self.archive.open(f"files/{name}") as member, destination.open("wb") as handle:
            for block in iter(lambda: member.read(1024 * 1024), b""):
                size += len(block)
                if size > info["size"]:
                    raise BackupError(f"Attachment {name} is larger than the manifest states.")
                digest.update(block)
                handle.write(block)
        if size != info["size"] or digest.hexdigest() != info["sha256"]:
            raise BackupError(f"Attachment {name} does not match the manifest (the backup is corrupted or was modified).")

    def verify_file(self, name: str) -> None:
        info = self.manifest["files"][name]
        digest, size = hashlib.sha256(), 0
        with self.archive.open(f"files/{name}") as member:
            for block in iter(lambda: member.read(1024 * 1024), b""):
                size += len(block)
                if size > info["size"]:
                    raise BackupError(f"Attachment {name} is larger than the manifest states.")
                digest.update(block)
        if size != info["size"] or digest.hexdigest() != info["sha256"]:
            raise BackupError(f"Attachment {name} does not match the manifest (the backup is corrupted or was modified).")

    def close(self) -> None:
        self.archive.close()


def _open_source(path: Path) -> _Source:
    try:
        with path.open("rb") as handle:
            header = handle.read(4)
    except OSError as error:
        raise BackupError("The backup file could not be read.") from error
    if header[:2] == b"PK":
        return _ZipSource(path)
    return _LegacySource(path)


# Validation and row preparation
class _Context:
    # Validates rows against the models and tracks what is needed to check references.

    def __init__(self, source: _Source, tables: list, user_ids: set[int]):
        self.source = source
        self.user_ids = user_ids
        names = {table.name for table in tables}
        self.in_scope = names
        self.kinds = {table.name: {column.name: _kind(column) for column in table.columns} for table in tables}
        self.refs: dict[str, list] = {}      # (is_self, fk column, target column) inside the backup
        self.accounts: dict[str, list] = {}  # fk columns that point at auth_users (not part of the backup)
        self.watched: set[tuple[str, str]] = set()
        for table in tables:
            self.refs[table.name], self.accounts[table.name] = [], []
            for fk in table.foreign_keys:
                target = fk.column
                if target.table.name in names:
                    self.refs[table.name].append((target.table.name == table.name, fk.parent, target))
                    self.watched.add((target.table.name, target.name))
                elif target.table.name == "auth_users":
                    self.accounts[table.name].append(fk.parent)
                # any other target is left to the database to enforce
        for _table, foreign_key, _action in _external_references(tables):
            self.watched.add((foreign_key.column.table.name, foreign_key.column.name))
        self.ids: dict[tuple[str, str], set] = {key: set() for key in self.watched}
        self.attachment_names: list[str] = []
        self.attachment_documents: dict[str, tuple[Any, str]] = {}  # stored name -> (document id, original name)
        self.reset_report()

    def reset_report(self) -> None:
        self.cleared: dict[str, int] = {}
        self.dropped: dict[str, int] = {}
        self.counts: dict[str, int] = {}

    def begin_table(self, table) -> None:
        pk = list(table.primary_key.columns)
        ascending = len(pk) == 1 and self.kinds[table.name][pk[0].name] == "int" and self.source.ordered
        self.pk_seen = float("-inf") if ascending else set()
        self.counts[table.name] = 0
        self.parents: dict[Any, Any] = {}

    def prepare(self, table, raw: Any, number: int) -> dict[str, Any] | None:
        name = table.name
        if not isinstance(raw, dict):
            raise BackupError(f"Table {name}, row {number}: expected an object.")
        unknown = sorted(set(raw) - {column.name for column in table.columns})
        if unknown:
            raise BackupError(f"Table {name}, row {number}: unknown column {unknown[0]!r}. The backup was made by a different "
                "version of NEM."
            )
        row: dict[str, Any] = {}
        for column in table.columns:
            where = f"Table {name}, row {number}, column {column.name}"
            if column.name not in raw:
                optional = column.nullable or column.default is not None or column.server_default is not None
                if not optional or column.primary_key:
                    raise BackupError(f"{where}: column is missing.")
                continue
            kind = self.kinds[name][column.name]
            value = _decode(raw[column.name], column, kind, where)
            if value is None and kind == "json" and column.default is None and column.server_default is None:
                continue  # store SQL NULL rather than the JSON value null
            row[column.name] = value

        pk_columns = list(table.primary_key.columns)
        key = tuple(row.get(column.name) for column in pk_columns)
        if any(part is None for part in key):
            raise BackupError(f"Table {name}, row {number}: primary key is missing.")
        label = key[0] if len(key) == 1 else key
        if isinstance(self.pk_seen, set):
            if key in self.pk_seen:
                raise BackupError(f"Table {name}, row {number}: duplicate primary key {label}.")
            self.pk_seen.add(key)
        else:
            if key[0] <= self.pk_seen:
                raise BackupError(f"Table {name}, row {number}: primary keys must be unique and ascending (id {label}).")
            self.pk_seen = key[0]

        # Accounts are not part of the backup: clear nullable references to missing ones, skip rows that need them.
        for column in self.accounts[name]:
            value = row.get(column.name)
            if value is not None and value not in self.user_ids:
                if column.nullable:
                    row[column.name] = None
                    tag = f"{name}.{column.name}"
                    self.cleared[tag] = self.cleared.get(tag, 0) + 1
                else:
                    self.dropped[name] = self.dropped.get(name, 0) + 1
                    return None

        for is_self, column, target in self.refs[name]:
            value = row.get(column.name)
            if value is None:
                continue
            if is_self:
                self.parents[key[0]] = value  # may point forward in the file: checked in end_table
            elif value not in self.ids[(target.table.name, target.name)]:
                raise BackupError(f"Table {name}, row {number}: {column.name}={value} refers to a {target.table.name} row that "
                    "is not in the backup."
                )
        for table_name, column_name in self.watched:
            if table_name == name:
                self.ids[(table_name, column_name)].add(row[column_name])
        if name == InstructionDocumentFile.__tablename__:
            self.attachment_names.append(row["stored_name"])
            self.attachment_documents[row["stored_name"]] = (row.get("document_id"), row.get("original_name", ""))
        self.counts[name] += 1
        return row

    def end_table(self, table) -> None:
        if not self.parents:
            return
        target = next(t for is_self, _, t in self.refs[table.name] if is_self)
        known = self.ids[(table.name, target.name)]
        for child, parent in self.parents.items():
            if parent not in known:
                raise BackupError(f"Table {table.name}: row {child} refers to a missing parent {parent}.")
        for start in self.parents:
            seen, current = set(), start
            while current in self.parents:
                if current in seen:
                    raise BackupError(f"Table {table.name}: rows refer to each other in a loop (id {current}).")
                seen.add(current)
                current = self.parents[current]


def _self_reference_order(table, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Parents before children, so the insert never depends on statement batching.
    fk = next(fk for fk in table.foreign_keys if fk.column.table.name == table.name)
    child, parent = fk.parent.name, fk.column.name
    by_id = {row[parent]: row for row in rows}
    ordered, placed = [], set()

    def place(row):
        stack = [row]
        while stack:
            current = stack[-1]
            ancestor = current.get(child)
            if ancestor is not None and ancestor not in placed and ancestor in by_id:
                stack.append(by_id[ancestor])
                continue
            stack.pop()
            if current[parent] not in placed:
                placed.add(current[parent])
                ordered.append(current)

    for row in rows:
        place(row)
    return ordered


# Restore
def _quote(connection: Connection, name: str) -> str:
    return connection.dialect.identifier_preparer.quote(name)


def _validate(source: _Source, tables: list, user_ids: set[int]) -> _Context:
    context = _Context(source, tables, user_ids)
    for table in tables:
        context.begin_table(table)
        for number, raw in enumerate(source.rows(table), 1):
            context.prepare(table, raw, number)
        context.end_table(table)
    return context


def _remove_stale_work_files(directory: Path, pattern: str) -> None:
    # Leftovers of a crashed backup/restore (older than a day) are removed; nothing else is touched.
    cutoff = datetime.now().timestamp() - 24 * 3600
    for path in directory.glob(pattern):
        try:
            if path.is_dir() and (path / "recovery.json").exists():
                continue  # recovery data is only ever removed by an administrator action
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
        except OSError:
            pass


def _classify_attachments(source: _Source, names: list[str]) -> tuple[list[str], list[str]]:
    # Split the attachment names the rows refer to into (included in the backup, reported missing).
    info, known_missing = source.file_info(), source.missing_files()
    included, missing = [], []
    for name in dict.fromkeys(names):
        if not _SAFE_STORED_NAME.match(name) or not name.lower().endswith(_ALLOWED_ATTACHMENT_SUFFIXES):
            raise BackupError(f"The backup refers to an attachment with an invalid file name ({name!r}).")
        if name in info:
            included.append(name)
        elif name in known_missing:
            missing.append(name)
        else:
            raise BackupError(f"Attachment {name} is referenced by the backup but is neither included nor reported missing.")
    return included, missing


def _stage_attachments(source: _Source, names: list[str]) -> tuple[Path | None, dict[str, str], list[str]]:
    # Copy and verify the attachments in a staging folder beside the upload folder.

    # Returns (folder, {name in backup: name to store under}, names that were already missing when the backup
    # was made). If the upload folder already holds a DIFFERENT file with a restored attachment's name, the
    # restored file gets a new unique name (the database rows are rewritten to match); the existing file is kept.
    staged, missing = _classify_attachments(source, names)
    if not staged:
        return None, {}, missing
    DOCUMENT_UPLOAD_DIR.parent.mkdir(parents=True, exist_ok=True)
    _remove_stale_work_files(DOCUMENT_UPLOAD_DIR.parent, ".restore-*")
    folder = Path(tempfile.mkdtemp(dir=DOCUMENT_UPLOAD_DIR.parent, prefix=".restore-"))
    try:
        final: dict[str, str] = {}
        for name in staged:
            source.stage_file(name, folder / name)
            existing = DOCUMENT_UPLOAD_DIR / name
            final[name] = name
            if existing.exists() and _sha256(existing) != _sha256(folder / name):
                renamed = f"{uuid4().hex}{Path(name).suffix.lower()}"
                while (DOCUMENT_UPLOAD_DIR / renamed).exists():
                    renamed = f"{uuid4().hex}{Path(name).suffix.lower()}"
                os.replace(folder / name, folder / renamed)
                final[name] = renamed
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return folder, final, missing


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _place_file(source: Path, destination: Path) -> None:
    # Exclusive create: never overwrites a file that exists or appears meanwhile. Only a destination that THIS call
    # created is cleaned up after a failure, so a failed exclusive create (FileExistsError, because someone else
    # made the file) can never delete another user's file.
    created = False
    try:
        with source.open("rb") as reader, destination.open("xb") as writer:
            created = True
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise
    try:
        source.unlink()
    except OSError:
        pass  # the staged copy is removed with its folder; the file itself is safely in place


def _install_file(source: Path, destination: Path) -> None:
    # Identical content already in place counts as installed; different content is a conflict. Never overwrites.
    if destination.exists():
        if _sha256(destination) != _sha256(source):
            raise FileExistsError("a different file already uses this name")
        source.unlink(missing_ok=True)
        return
    _place_file(source, destination)


def _promote_attachments(folder: Path | None, names: list[str], owners: dict[str, tuple[Any, str]]) -> tuple[list[dict[str, Any]], str | None]:
    """After the commit, put the staged files into the upload folder. Existing files are never overwritten or deleted.

    Names are collision-free after staging, so a failure means the folder is not writable or a different file
    appeared under that name since. Returns (failures, recovery folder name). On failure the staging folder is kept
    under a name that is never auto-cleaned, with a recovery.json listing each affected document, so the files
    can be copied into place later.
    """
    if folder is None:
        return [], None
    failures: list[dict[str, Any]] = []
    try:
        DOCUMENT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.error("Upload folder is not available")
    for name in names:
        source, destination = folder / name, DOCUMENT_UPLOAD_DIR / name
        document_id, original_name = owners.get(name, (None, ""))
        try:
            _install_file(source, destination)
        except OSError as error:
            logger.error("Could not place restored attachment %s (%s)", name, error.__class__.__name__)
            failures.append({"stored_name": name, "document_id": document_id, "original_name": original_name,
                             "reason": error.strerror or error.__class__.__name__})
    if not failures:
        shutil.rmtree(folder, ignore_errors=True)
        return [], None
    recovery = folder.parent / f"restore-recovery-{uuid4().hex[:12]}"
    try:
        (folder / "recovery.json").write_text(json.dumps({
            "note": "Copy each listed file into uploads/instruction_documents/ under its stored_name once the cause is fixed.",
            "files": failures,
        }, indent=1), encoding="utf-8")
        os.replace(folder, recovery)
        return failures, recovery.name
    except OSError:
        logger.exception("Could not write the recovery note")
        return failures, folder.name


def resolve_backup_path(settings: Settings, filename: str) -> Path:
    # Map a stored backup file name to its path inside the backup directory (nothing else is ever reachable).
    if not _SAFE_BACKUP_NAME.match(filename):
        raise HTTPException(status_code=422, detail="Invalid backup filename")
    directory = backup_directory(settings)
    target = directory / filename
    if target.is_symlink() or target.resolve().parent != directory:
        raise HTTPException(status_code=422, detail="Invalid backup filename")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Backup file was not found")
    return target


def _load(engine: Engine, target: Path):
    # Open and fully validate a backup. Returns (source, is_legacy, tables, context). Changes nothing.
    source = _open_source(target)
    try:
        legacy = source.version == 1
        names = source.table_names()
        if legacy:
            expected = set(_LEGACY_TABLE_NAMES)
            missing_tables = sorted(expected - _LEGACY_OPTIONAL - names)
        else:
            expected = {table.name for table in _ordered_tables()} # type: ignore
            missing_tables = sorted(expected - names)
        unknown = sorted(names - expected)
        if unknown:
            raise BackupError(f"The backup contains an unknown table ({unknown[0]}).")
        if missing_tables:
            raise BackupError(f"The backup is incomplete (missing table {missing_tables[0]}).")
        tables = _ordered_tables(expected) # type: ignore
        with engine.connect() as probe:  # a separate connection: the caller's session is not used
            user_ids = {value for (value,) in probe.execute(text("SELECT id FROM auth_users"))}
        context = _validate(source, tables, user_ids)
        return source, legacy, tables, context
    except BaseException:
        source.close()
        raise


#  impact of replacing the tables on rows OUTSIDE the backup 
def _external_references(tables: list) -> list:
    # Foreign keys from tables that are NOT replaced to tables that ARE replaced: [(table, fk, ON DELETE rule)].
    replaced = set(tables)
    found = []
    for table in sorted(Base.metadata.tables.values(), key=lambda item: item.name):
        if table in replaced:
            continue
        for foreign_key in sorted(table.foreign_keys, key=lambda item: item.parent.name):
            if foreign_key.column.table in replaced:
                found.append((table, foreign_key, (foreign_key.ondelete or "NO ACTION").upper()))
    return found


def _lock_external_tables(connection: Connection, tables: list) -> None:
    # Lock them as well, so the counted impact cannot change between the check and the delete.
    for name in sorted({table.name for table, _fk, _action in _external_references(tables)}):
        connection.execute(text(f"LOCK TABLE {_quote(connection, name)} IN EXCLUSIVE MODE"))


def _external_impact(connection: Connection, tables: list, restored_ids: dict) -> tuple[dict[str, list], list]:
    """What replacing ``tables`` does to rows outside the backup, by the foreign keys' ON DELETE rules.

    cascade      rows are DELETED together with their parent (outside the backup scope);
    set_null     the link is cleared; it is put back afterwards when the parent exists in the backup ('relinked');
    set_default  the column falls back to its default;
    blockers     RESTRICT / NO ACTION: these rows would make the delete fail, so the restore is refused.
    Returns (impact, captured links to re-apply after the insert).
    """
    impact: dict[str, list] = {"cascade": [], "set_null": [], "set_default": [], "blockers": []}
    captured = []
    for table, foreign_key, action in _external_references(tables):
        column, target = foreign_key.parent, foreign_key.column
        count = connection.execute(select(func.count()).select_from(table).where(column.is_not(None))).scalar() or 0
        if not count:
            continue
        entry = {"table": table.name, "column": column.name, "references": target.table.name, "rows": int(count)}
        pk = list(table.primary_key.columns)
        if action == "CASCADE":
            impact["cascade"].append(entry)
        elif action == "SET NULL":
            known = restored_ids.get((target.table.name, target.name), set())
            if len(pk) == 1:
                rows = connection.execute(select(pk[0], column).where(column.is_not(None))).all()
                captured.append((table, pk[0], column, target, rows))
                relinked = sum(1 for _pk, value in rows if value in known)
            else:
                relinked = 0  # no single key to put the link back with
            impact["set_null"].append({**entry, "relinked": relinked, "cleared": int(count) - relinked})
        elif action == "SET DEFAULT":
            impact["set_default"].append(entry)
        else:
            impact["blockers"].append({**entry, "rule": action})
    return impact, captured


def _needs_confirmation(impact: dict[str, list], legacy: bool) -> bool:
    return bool(legacy or impact["cascade"] or impact["set_default"] or any(item["cleared"] for item in impact["set_null"]))

# confirmation bound to one backup and its exact impact 

def _confirmation_key(settings: Settings) -> bytes:
    secret = settings.settings_encryption_key.get_secret_value().encode("utf-8")
    return hashlib.sha256(b"nem-restore-confirmation:" + secret).digest()


def _impact_fingerprint(backup_sha256: str, legacy: bool, impact: dict[str, list]) -> str:
    payload = json.dumps([backup_sha256, legacy, impact], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _issue_confirmation(settings: Settings, filename: str, backup_sha256: str, fingerprint: str, user_id: Any) -> str:
    payload = {"b": filename, "h": backup_sha256, "i": fingerprint, "u": user_id, "e": int(time.time()) + _CONFIRMATION_TTL_SECONDS}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
    signature = hmac.new(_confirmation_key(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _check_confirmation(settings: Settings, token: str | None, filename: str, backup_sha256: str, fingerprint: str, user_id: Any) -> str | None:
    # Returns None when the confirmation is valid, otherwise the message to show.
    if not token:
        return "This restore needs explicit confirmation of its impact. Run the restore preview and confirm it first. Nothing was changed."
    try:
        body, signature = token.rsplit(".", 1)
        expected = hmac.new(_confirmation_key(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return "The confirmation is not valid. Run the restore preview again. Nothing was changed."
        payload = json.loads(base64.urlsafe_b64decode(body.encode("ascii")))
    except (ValueError, UnicodeError):
        return "The confirmation is not valid. Run the restore preview again. Nothing was changed."
    if not isinstance(payload, dict) or payload.get("e", 0) < time.time():
        return "The confirmation has expired. Run the restore preview again. Nothing was changed."
    if payload.get("b") != filename or payload.get("u") != user_id:
        return "The confirmation belongs to a different backup or user. Run the restore preview again. Nothing was changed."
    if payload.get("h") != backup_sha256 or payload.get("i") != fingerprint:
        return ("The backup or the affected data changed since the preview was confirmed. "
                "Run the restore preview again and review the impact. Nothing was changed.")
    return None


#preview 

_LEGACY_LIMITATIONS = (
    "This backup uses the old format (version 1). It does not contain labels and label links, instruction attachment "
    "files and metadata, asset supervisor assignments, maintenance schedules, machine monitoring states, or shared-rule "
    "history and visibility grants. Rows of those kinds that exist now are removed together with the replaced data "
    "(see the external impact) and are not restored."
)


def analyze_restore(settings: Settings, engine: Engine, filename: str, user_id: Any = None) -> dict[str, Any]:
    # Validate a backup completely and describe exactly what a restore would do. Changes nothing.
    target = resolve_backup_path(settings, filename)
    base: dict[str, Any] = {"valid": False, "can_restore": False, "confirmation_required": False, "confirmation_token": None, "issues": []}
    source = None
    try:
        backup_sha256 = _sha256(target)
        source, legacy, tables, context = _load(engine, target)
        attachments_checked = 0
        if not legacy:
            for name in source.file_info():
                source.verify_file(name)
                attachments_checked += 1
        info = source.file_info()
        included, missing = _classify_attachments(source, context.attachment_names)
    except BackupError as error:
        if source is not None:
            source.close()
        return {**base, "issues": [str(error)]}
    try:
        owners = context.attachment_documents
        describe = lambda name: {"stored_name": name, "document_id": owners[name][0], "original_name": owners[name][1]}
        renamed = []
        for name in included:
            existing = DOCUMENT_UPLOAD_DIR / name
            if existing.exists() and _sha256(existing) != info[name]["sha256"]:
                renamed.append(describe(name))
        with engine.connect() as connection:
            table_rows = [
                {"table": table.name,
                 "current": int(connection.execute(select(func.count()).select_from(table)).scalar() or 0),
                 "restore": int(context.counts.get(table.name, 0))}
                for table in tables
            ]
            impact, _captured = _external_impact(connection, tables, context.ids)
        needs_confirmation = _needs_confirmation(impact, legacy)
        warnings = [w for w in _report_warnings(context, [], [], 0, None)]
        limitations = [_LEGACY_LIMITATIONS] if legacy else []
        can_restore = not impact["blockers"]
        token = None
        if can_restore:
            token = _issue_confirmation(settings, filename, backup_sha256, _impact_fingerprint(backup_sha256, legacy, impact), user_id)
        return {
            "valid": True,
            "can_restore": can_restore,
            "issues": [
                f"{item['rows']} row(s) in {item['table']} still refer to data this restore replaces ({item['rule']}); "
                "they must be removed or migrated first." for item in impact["blockers"]
            ],
            "backup": {"format_version": source.version, "legacy": legacy, "size_bytes": target.stat().st_size,
                       "created_at": getattr(source, "manifest", {}).get("created_at")},
            "validation": {"archive": True, "tables_present": True, "checksums_verified": not legacy,
                           "attachments_verified": attachments_checked, "legacy_limitations": legacy},
            "tables": table_rows,
            "attachments": {"restore": len(included), "renamed": renamed, "missing": [describe(n) for n in missing]},
            "external": impact,
            "limitations": limitations,
            "warnings": warnings,
            "confirmation_required": needs_confirmation,
            "confirmation_token": token,
        }
    finally:
        source.close()


# restore 
def _database_error(error: DBAPIError) -> HTTPException:
    # A safe message for a database failure: schema names only, never SQL, parameters or row values.
    original = getattr(error, "orig", None)
    code = getattr(original, "pgcode", None) or ""
    diag = getattr(original, "diag", None)
    table, constraint = getattr(diag, "table_name", None), getattr(diag, "constraint_name", None)
    logger.error("Restore failed and was rolled back: sqlstate=%s table=%s constraint=%s", code or "?", table, constraint)
    if code in ("55P03", "40P01"):
        return HTTPException(status_code=409, detail=(
            "The database is busy and the restore could not get exclusive access. Nothing was changed. Try again shortly."))
    if code.startswith("23"):
        where = f" (table {table}, constraint {constraint})" if table or constraint else ""
        return HTTPException(status_code=422, detail=(
            f"The database rejected the backup data because it violates a constraint{where}. "
            "The restore was rolled back; nothing was changed."))
    if code.startswith("22"):
        return HTTPException(status_code=422, detail=(
            "The database rejected a value in the backup (invalid or out of range). "
            "The restore was rolled back; nothing was changed."))
    return HTTPException(status_code=500, detail="The restore failed and was rolled back; the existing data was not changed.")


def restore_backup(session: Session, engine: Engine, settings: Settings, filename: str,
                   confirmation_token: str | None = None, user_id: Any = None) -> dict[str, Any]:
    # Replace the data in scope with the backup. Returns a report; raises HTTPException on failure.

   # The database part (locks, impact check, delete, insert, sequence reset) is ONE transaction on its own
   # connection: if any of it fails it is rolled back and the existing data is unchanged. The caller's session is
   # never committed, rolled back or flushed (it is only expired afterwards, so it cannot return stale objects).
   # Attachment files are moved into place and the follow-up migrations run only after that transaction has
   # committed; they are reported separately (outcome 'partial' if files could not be placed) and cannot undo the restore.

    target = resolve_backup_path(settings, filename)
    # Policy: refuse while the caller's session has unsaved changes, which the restore would otherwise bypass.
    if session.new or session.dirty or session.deleted:
        raise HTTPException(status_code=409, detail="The request has unsaved changes; save or discard them first. Nothing was changed.")

    source: _Source | None = None
    staging: Path | None = None
    committed = False
    try:
        #  1. Read and validate everything; stage the attachments. Nothing in the database has changed yet.
        try:
            backup_sha256 = _sha256(target)
            source, legacy, tables, context = _load(engine, target)
            staging, staged, missing_attachments = _stage_attachments(source, context.attachment_names)
            renames = {old: new for old, new in staged.items() if old != new}
        except BackupError as error:
            raise HTTPException(status_code=422, detail=f"The backup cannot be restored: {error} Nothing was changed.") from error

        #  2. One transaction: lock, re-check the impact, delete, insert, reset sequences, commit.
        connection = engine.connect()
        transaction = connection.begin()
        try:
            connection.execute(text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'"))
            if not connection.execute(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": _RESTORE_LOCK_KEY}).scalar():
                raise HTTPException(status_code=409, detail="Another restore is already in progress. Nothing was changed.")
            # Writers (alert evaluation, data collection, API requests) wait here until the swap is committed;
            # readers are not blocked.
            for table in tables:
                connection.execute(text(f"LOCK TABLE {_quote(connection, table.name)} IN EXCLUSIVE MODE"))
            _lock_external_tables(connection, tables)

            impact, captured = _external_impact(connection, tables, context.ids)
            if impact["blockers"]:
                first = impact["blockers"][0]
                raise BackupError(f"{first['rows']} row(s) in {first['table']} still refer to data that the restore replaces "
                    f"({first['rule']}). Remove or migrate them first."
                )
            # Bind every restore to a reviewed preview, even when no external impact was found.
            problem = _check_confirmation(
                settings, confirmation_token, filename, backup_sha256,
                _impact_fingerprint(backup_sha256, legacy, impact), user_id,
            )
            if problem:
                raise HTTPException(status_code=409, detail=problem)

            for table in reversed(tables):
                connection.execute(delete(table))

            context.reset_report()
            for table in tables:
                context.begin_table(table)
                self_ref = any(fk.column.table.name == table.name for fk in table.foreign_keys)
                batch: list[dict[str, Any]] = []
                signature: tuple | None = None
                pending: list[dict[str, Any]] = []
                for number, raw in enumerate(source.rows(table), 1):
                    row = context.prepare(table, raw, number)
                    if row is None:
                        continue
                    if renames and table.name == InstructionDocumentFile.__tablename__:
                        row["stored_name"] = renames.get(row["stored_name"], row["stored_name"])
                    if self_ref:
                        pending.append(row)
                        continue
                    row_signature = tuple(sorted(row))
                    if batch and (row_signature != signature or len(batch) >= _BATCH):
                        connection.execute(insert(table), batch)
                        batch = []
                    signature = row_signature
                    batch.append(row)
                if self_ref:
                    ordered = _self_reference_order(table, pending)
                    for start in range(0, len(ordered), _BATCH):
                        connection.execute(insert(table), ordered[start:start + _BATCH])
                elif batch:
                    connection.execute(insert(table), batch)
                context.end_table(table)

            for table in tables:
                _reset_sequence(connection, table)
            for table, pk, column, target_column, rows in captured:
                existing = {value for (value,) in connection.execute(select(target_column))}
                restored = [{"_pk": row_pk, "_value": value} for row_pk, value in rows if value in existing]
                if restored:
                    connection.execute(
                        table.update().where(pk == bindparam("_pk")).values({column.name: bindparam("_value")}), restored
                    )
            transaction.commit()
            committed = True
        except HTTPException:
            _rollback(transaction)
            raise
        except BackupError as error:
            _rollback(transaction)
            raise HTTPException(status_code=422,detail=f"The backup cannot be restored: {error} The restore was rolled back; nothing was changed.", ) from error
        except DBAPIError as error:
            _rollback(transaction)
            raise _database_error(error) from None
        except Exception as error:
            _rollback(transaction)
            logger.error("Restore failed and was rolled back (%s)", error.__class__.__name__)
            raise HTTPException(status_code=500, detail="The restore failed and was rolled back; the existing data was not changed.") from None
        finally:
            connection.close()

        # 3. Committed. Everything below only completes the restore and reports on it.
        session.expire_all()  # sessions use expire_on_commit=False: drop objects loaded before the swap
        owners = {renames.get(old, old): owner for old, owner in context.attachment_documents.items()}
        failed_files, recovery_folder = _promote_attachments(staging, list(staged.values()), owners)
        staging = None  # either removed, or kept as the recovery folder
        migration_warnings = _post_restore_migrations(engine)
        warnings = _report_warnings(context, missing_attachments, failed_files, len(renames), recovery_folder)
        warnings.extend(_describe_external(impact))
        warnings.extend(migration_warnings)
        who = {name: (context.attachment_documents[name][0], context.attachment_documents[name][1]) for name in context.attachment_documents}
        entry = lambda name: {"stored_name": name, "document_id": who[name][0], "original_name": who[name][1]}
        logger.info(
            "Database restored from %s (format version %s); rows=%s; failed_files=%s; warnings=%s",
            filename, source.version, {name: count for name, count in context.counts.items() if count},
            len(failed_files), len(warnings),
        )
        return {
            "committed": True,
            "outcome": "partial" if failed_files else "complete",
            "format_version": source.version,
            "legacy": legacy,
            "rows": dict(context.counts),
            "files": len(staged) - len(failed_files),
            "renamed": [{**entry(old), "new_stored_name": new} for old, new in renames.items()],
            "missing_attachments": [entry(name) for name in missing_attachments],
            "failed_files": failed_files,
            "recovery_folder": recovery_folder,
            "external": impact,
            "migration_warnings": migration_warnings,
            "warnings": warnings,
        }
    finally:
        if source is not None:
            source.close()
        if staging is not None and not committed:
            shutil.rmtree(staging, ignore_errors=True)


def _describe_external(impact: dict[str, list]) -> list[str]:
    notes = []
    for item in impact["cascade"]:
        notes.append(f"{item['rows']} row(s) of {item['table']} were deleted together with the replaced data (outside the backup).")
    for item in impact["set_null"]:
        if item["cleared"]:
            notes.append(f"{item['cleared']} link(s) in {item['table']}.{item['column']} were cleared (the target is not in the backup); {item['relinked']} were kept.")
    for item in impact["set_default"]:
        notes.append(f"{item['rows']} value(s) in {item['table']}.{item['column']} were reset to their default.")
    return notes


def _rollback(transaction) -> None:
    try:
        if transaction.is_active:
            transaction.rollback()
    except Exception:
        logger.exception("Rollback failed")


def _reset_sequence(connection: Connection, table) -> None:
    # Only a single integer primary key can be fed by a sequence; pg_get_serial_sequence() returns NULL for
    # columns without a serial/identity sequence (manually assigned keys), which are then left alone.
    pk = list(table.primary_key.columns)
    if len(pk) != 1 or _kind(pk[0]) != "int":
        return
    quoted_table, quoted_column = _quote(connection, table.name), _quote(connection, pk[0].name)
    sequence = connection.execute(
        text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
        {"table_name": quoted_table, "column_name": pk[0].name},
    ).scalar()
    if sequence:
        connection.execute(
            text(
                "SELECT setval(CAST(:sequence AS regclass), "
                f"COALESCE((SELECT MAX({quoted_column}) FROM {quoted_table}), 1), "
                f"EXISTS(SELECT 1 FROM {quoted_table}))"
            ),
            {"sequence": sequence},
        )


def _report_warnings(context: _Context, missing_attachments: list[str], failed_files: list[dict[str, Any]],
                     renamed: int = 0, recovery_folder: str | None = None) -> list[str]:
    warnings = []
    for label, count in sorted(context.cleared.items()):
        warnings.append(f"{count} reference(s) in {label} pointed to user accounts that no longer exist; they were cleared (recorded names are kept).")
    for table, count in sorted(context.dropped.items()):
        warnings.append(f"{count} row(s) of {table} were skipped because their user account no longer exists.")
    if missing_attachments:
        warnings.append(f"{len(missing_attachments)} attachment file(s) were already missing when the backup was made; those documents show 'File missing'.")
    if renamed:
        warnings.append(
            f"{renamed} attachment(s) were restored under new file names because different files with the same "
            "names already exist in the upload folder (the existing files were kept)."
        )
    if failed_files:
        warnings.append(
            f"{len(failed_files)} attachment file(s) could not be placed in the upload folder; the database is restored, "
            "but these documents will not open: " + _describe_documents(failed_files)
            + (f". The files were kept in the folder '{recovery_folder}' next to the upload folder (see recovery.json "
               "there); copy them into 'instruction_documents' under the listed stored names once the cause "
               "(permissions or a conflicting file) is fixed." if recovery_folder else ".")
        )
    return warnings


def _post_restore_migrations(engine: Engine) -> list[str]:
    # Start-up migrations that normalise legacy rows. They are not needed for the restore to be correct (they
    # run again at every application start), so a failure here is reported but never turns a committed
    # restore into a failed one.
    from app.db.init_db import _migrate_existing_rule_counters, _migrate_legacy_rule_templates

    warnings = []
    for step in (_migrate_legacy_rule_templates, _migrate_existing_rule_counters):
        try:
            step(engine)
        except Exception:
            logger.exception("Post-restore migration %s failed", step.__name__)
            warnings.append(
                f"The data was restored, but the follow-up step {step.__name__.lstrip('_')} failed. "
                "It runs again automatically the next time the application starts."
            )
    return warnings


# backup history helpers: summary, details, delete, upload, storage, recovery

_SUMMARY_CACHE: dict[tuple, dict[str, Any]] = {}


def _safe_backup_file(settings: Settings, filename: str) -> Path | None:
    if not _SAFE_BACKUP_NAME.match(filename):
        return None
    directory = backup_directory(settings)
    path = directory / filename
    if path.is_symlink() or path.resolve().parent != directory or not path.is_file():
        return None
    return path


def backup_summary(settings: Settings, filename: str, detailed: bool = False) -> dict[str, Any]:
    """Facts about one stored backup read from its manifest (no database access, no full validation).
    status: 'ok' | 'warning' (attachment problems or old format) | 'file_missing' | 'unreadable'.
    Full checksum validation happens in the restore preview.
    """
    path = _safe_backup_file(settings, filename)
    if path is None:
        return {"status": "file_missing", "size_bytes": None, "format_version": None, "warnings": ["The backup file is missing from the server."]}
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size, detailed)
    cached = _SUMMARY_CACHE.get(key)
    if cached is not None:
        return cached
    summary: dict[str, Any] = {"size_bytes": stat.st_size, "format_version": None, "status": "ok", "warnings": [],
                               "tables": None, "rows": None, "attachments": 0, "missing_attachments": 0, "inconsistent_attachments": 0}
    try:
        with path.open("rb") as handle:
            header = handle.read(2)
        if header == b"PK":
            source = _ZipSource(path)
            try:
                manifest = source.manifest
                summary.update(
                    format_version=manifest["format_version"], created_at=manifest.get("created_at"),
                    tables=len(manifest["tables"]), rows=sum(item["rows"] for item in manifest["tables"].values()),
                    attachments=len(manifest["files"]),
                    missing_attachments=len(manifest.get("missing_details", manifest.get("missing_files", []))),
                    inconsistent_attachments=len(manifest.get("inconsistent_details", manifest.get("inconsistent_files", []))),
                )
                if summary["missing_attachments"]:
                    summary["warnings"].append(f"{summary['missing_attachments']} attachment file(s) were missing when this backup was made.")
                if summary["inconsistent_attachments"]:
                    summary["warnings"].append(f"{summary['inconsistent_attachments']} attachment file(s) differed in size from the database record.")
                if detailed:
                    summary["table_rows"] = {name: item["rows"] for name, item in sorted(manifest["tables"].items())}
                    summary["files"] = [{"stored_name": name, "size_bytes": item["size"]} for name, item in sorted(manifest["files"].items())]
                    summary["missing_details"] = list(manifest.get("missing_details", []))
                    summary["inconsistent_details"] = list(manifest.get("inconsistent_details", []))
                    summary["snapshot"] = manifest.get("snapshot")
            finally:
                source.close()
        else:
            summary["format_version"] = 1
            summary["warnings"].append("Old backup format (version 1): it does not include several newer tables and no attachment files.")
            if detailed:
                summary["limitations"] = [_LEGACY_LIMITATIONS]
        if summary["warnings"]:
            summary["status"] = "warning"
    except (BackupError, OSError):
        summary.update(status="unreadable", warnings=["The backup archive could not be read; it may be damaged."])
    if len(_SUMMARY_CACHE) > 256:
        _SUMMARY_CACHE.clear()
    _SUMMARY_CACHE[key] = summary
    return summary


def delete_backup_file(engine: Engine, settings: Settings, filename: str) -> None:
    # Remove a backup file. Refused while a restore is running (which may be reading it).
    with engine.connect() as connection:
        if not connection.execute(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": _RESTORE_LOCK_KEY}).scalar():
            raise HTTPException(status_code=409, detail="A restore is running; backups cannot be deleted right now.")
        path = _safe_backup_file(settings, filename)
        if path is not None:
            try:
                path.unlink()
            except OSError as error:
                logger.error("Could not delete backup file %s (%s)", filename, error.__class__.__name__)
                raise HTTPException(status_code=500, detail="The backup file could not be deleted.") from None


def import_backup_file(engine: Engine, settings: Settings, stream, original_name: str, name: str | None, note: str | None):
    # Store an uploaded backup (ZIP v2 or old JSON v1) and add it to the history. Returns (record, summary).
    from app.models import BackupRecord

    directory = backup_directory(settings)
    handle, temporary_name = tempfile.mkstemp(dir=directory, prefix=".upload-", suffix=".tmp")  # mode 0600
    temporary = Path(temporary_name)
    try:
        size = 0
        with os.fdopen(handle, "wb") as out:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                size += len(block)
                if size > _MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="The backup file is too large (limit 2 GB).")
                out.write(block)
        if size == 0:
            raise HTTPException(status_code=422, detail="The uploaded file is empty.")
        with temporary.open("rb") as check:
            is_zip = check.read(2) == b"PK"
        if is_zip:
            try:
                _ZipSource(temporary).close()
            except BackupError as error:
                raise HTTPException(status_code=422, detail=f"This is not a valid backup: {error}") from error
            extension = "zip"
        else:
            if size > _MAX_LEGACY_BYTES:
                raise HTTPException(status_code=413, detail="An old-format (.json) backup can be at most 512 MB.")
            try:
                _LegacySource(temporary)
            except BackupError as error:
                raise HTTPException(status_code=422, detail=f"This is not a valid backup: {error}") from error
            extension = "json"
        filename = f"{uuid4().hex}.{extension}"
        os.replace(temporary, directory / filename)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    label = (name or "").strip() or f"Uploaded: {Path(original_name or 'backup').stem}"[:200]
    try:
        with Session(engine, expire_on_commit=False) as own:
            record = BackupRecord(name=label[:200], note=note, file_name=filename)
            own.add(record)
            own.commit()
            own.refresh(record)
            own.expunge(record)
    except Exception:
        (directory / filename).unlink(missing_ok=True)
        raise
    return record


def storage_report(settings: Settings, known_files: set[str]) -> dict[str, Any]:
    # Disk use of the backup folder, files no history record refers to, and unresolved attachment recoveries.
    directory = backup_directory(settings)
    used, orphans = 0, []
    for path in directory.iterdir():
        if path.is_file() and not path.name.startswith("."):
            used += path.stat().st_size
            if path.name not in known_files:
                orphans.append(path.name)
    return {"used_bytes": used, "orphan_files": len(orphans), "recovery": list_recovery()}


def list_recovery() -> list[dict[str, Any]]:
    # Folders left by a restore whose attachment files could not be placed, with what is still outstanding.
    root = DOCUMENT_UPLOAD_DIR.parent
    result = []
    if not root.is_dir():
        return result
    for folder in sorted(root.glob("restore-recovery-*")):
        if not folder.is_dir() or not _RECOVERY_NAME.match(folder.name):
            continue
        try:
            note = json.loads((folder / "recovery.json").read_text(encoding="utf-8"))
            entries = note.get("files", [])
        except (OSError, ValueError):
            entries = []
        files = []
        for item in entries:
            name = str(item.get("stored_name", ""))
            files.append({
                "stored_name": name, "document_id": item.get("document_id"), "original_name": item.get("original_name", ""),
                "reason": item.get("reason", ""), "waiting": bool(_SAFE_STORED_NAME.match(name)) and (folder / name).is_file(),
            })
        result.append({"folder": folder.name, "created_at": datetime.fromtimestamp(folder.stat().st_mtime, timezone.utc).isoformat(), "files": files})
    return result


def retry_recovery(folder_name: str) -> dict[str, Any]:
   # Try again to place the files of one recovery folder (never overwriting); the folder is removed once empty.
    if not _RECOVERY_NAME.match(folder_name):
        raise HTTPException(status_code=422, detail="Invalid recovery folder")
    folder = DOCUMENT_UPLOAD_DIR.parent / folder_name
    if not folder.is_dir() or folder.is_symlink():
        raise HTTPException(status_code=404, detail="Recovery folder was not found")
    DOCUMENT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    placed, remaining = 0, []
    for item in sorted(folder.iterdir()):
        if item.name == "recovery.json" or not item.is_file():
            continue
        if not _SAFE_STORED_NAME.match(item.name):
            remaining.append({"stored_name": item.name, "reason": "unsafe file name"})
            continue
        try:
            _install_file(item, DOCUMENT_UPLOAD_DIR / item.name)
            placed += 1
        except OSError as error:
            remaining.append({"stored_name": item.name, "reason": error.strerror or error.__class__.__name__})
    if not remaining:
        shutil.rmtree(folder, ignore_errors=True)
    return {"placed": placed, "remaining": remaining, "resolved": not remaining}
