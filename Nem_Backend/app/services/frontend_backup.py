"""Database backup and restore (dashboard data).

A backup is one ZIP archive (format version 2) written from a single PostgreSQL REPEATABLE READ
snapshot, so every table shows the same moment in time:

    manifest.json                    format, version, row counts, SHA-256 of every member
    tables/<table>.jsonl             one JSON object per row, ordered by primary key
    files/<stored_name>              the uploaded document attachments referenced by the backup

Older backups (format version 1) are a single ``.json`` file holding thirteen tables; they can still be
restored (see ``_LegacySource``).

Restore is a full replacement of the tables in scope. The archive is read and validated completely, and
the attachments are staged on disk, before the first row is deleted. All deletes, inserts and sequence
resets then run in ONE database transaction on the caller's session: if anything fails the transaction
is rolled back and the existing data is untouched. Files are moved into the upload folder only after the
commit, and existing upload files are never deleted.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import tempfile
import zipfile
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import BigInteger, Boolean, bindparam, Date, DateTime, Float, Integer, JSON, Numeric, String, delete, insert, func, select, text
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

DOCUMENT_UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads" / "instruction_documents"


class BackupError(Exception):
    """The backup is unreadable, incomplete or inconsistent. Nothing has been changed."""


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


# ---------------------------------------------------------------------------------------------------
# Column handling
# ---------------------------------------------------------------------------------------------------

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
        bits = 63 if isinstance(_unwrap(column.type), BigInteger) else 31
        if not -(2 ** bits) <= value < 2 ** bits:
            raise BackupError(f"{where}: {value} is outside the range of the column.")
        return value
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
        if precision is not None and scale is not None and number != 0:
            exponent = number.normalize().as_tuple().exponent  # trailing zeros do not count
            if max(-exponent, 0) > scale:
                raise BackupError(f"{where}: {raw!r} has more than {scale} decimal places (NUMERIC({precision},{scale})); it would be rounded.")
            if max(number.adjusted() + 1, 0) > precision - scale:
                raise BackupError(f"{where}: {raw!r} does not fit NUMERIC({precision},{scale}).")
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


def _json_line(row: dict[str, Any]) -> bytes:
    return (json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


# ---------------------------------------------------------------------------------------------------
# Creating a backup
# ---------------------------------------------------------------------------------------------------

def _write_archive(engine: Engine, path: Path) -> dict[str, Any]:
    tables = _ordered_tables()
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
    """Create a backup; returns (BackupRecord, report) where the report lists tables, files and warnings."""
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


def create_backup(session: Session, settings: Settings, name: str, note: str | None):
    return create_backup_with_report(session, settings, name, note)[0]


# ---------------------------------------------------------------------------------------------------
# Reading a backup
# ---------------------------------------------------------------------------------------------------

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
    """Format version 1: one JSON object, table name -> list of rows."""

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


# ---------------------------------------------------------------------------------------------------
# Validation and row preparation
# ---------------------------------------------------------------------------------------------------

class _Context:
    """Validates rows against the models and tracks what is needed to check references."""

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
            raise BackupError(
                f"Table {name}, row {number}: unknown column {unknown[0]!r}. The backup was made by a different "
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
                raise BackupError(
                    f"Table {name}, row {number}: {column.name}={value} refers to a {target.table.name} row that "
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


# ---------------------------------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------------------------------

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
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
        except OSError:
            pass


def _stage_attachments(source: _Source, names: list[str]) -> tuple[Path | None, dict[str, str], list[str]]:
    """Copy and verify the attachments in a staging folder beside the upload folder.

    Returns (folder, {name in backup: name to store under}, names that were already missing when the backup
    was made). If the upload folder already holds a DIFFERENT file with a restored attachment's name, the
    restored file gets a new unique name (the database rows are rewritten to match); the existing file is kept.
    """
    info, known_missing = source.file_info(), source.missing_files()
    staged, missing = [], []
    for name in dict.fromkeys(names):
        if not _SAFE_STORED_NAME.match(name) or not name.lower().endswith(_ALLOWED_ATTACHMENT_SUFFIXES):
            raise BackupError(f"The backup refers to an attachment with an invalid file name ({name!r}).")
        if name in info:
            staged.append(name)
        elif name in known_missing:
            missing.append(name)
        else:
            raise BackupError(f"Attachment {name} is referenced by the backup but is neither included nor reported missing.")
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
    # Exclusive create: never overwrites a file that appeared meanwhile. A partial copy is removed on error.
    try:
        with source.open("rb") as reader, destination.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
    except BaseException:
        if destination.exists() and destination.stat().st_size != source.stat().st_size:
            destination.unlink(missing_ok=True)
        raise
    source.unlink()


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
        logger.exception("Upload folder is not available")
    for name in names:
        source, destination = folder / name, DOCUMENT_UPLOAD_DIR / name
        document_id, original_name = owners.get(name, (None, ""))
        try:
            if destination.exists():
                if _sha256(destination) != _sha256(source):
                    raise FileExistsError("a different file already uses this name")
                source.unlink()  # identical content is already in place
            else:
                _place_file(source, destination)
        except OSError as error:
            logger.exception("Could not place restored attachment %s", name)
            failures.append({"stored_name": name, "document_id": document_id, "original_name": original_name,
                             "reason": error.strerror or str(error)})
    if not failures:
        shutil.rmtree(folder, ignore_errors=True)
        return [], None
    recovery = folder.parent / f"restore-recovery-{uuid4().hex[:12]}"
    try:
        (folder / "recovery.json").write_text(json.dumps({
            "note": "Copy each listed file into uploads/instruction_documents/ under its stored_name once the cause is fixed.",
            "target_folder": str(DOCUMENT_UPLOAD_DIR), "files": failures,
        }, indent=1), encoding="utf-8")
        os.replace(folder, recovery)
        return failures, recovery.name
    except OSError:
        logger.exception("Could not write the recovery note")
        return failures, folder.name


def restore_backup(session: Session, engine: Engine, settings: Settings, filename: str) -> dict[str, Any]:
    """Replace the data in scope with the backup. Returns a report; raises HTTPException on failure.

    Everything that touches the database (lock, delete, insert, sequence reset) is ONE transaction on the
    caller's session: if any of it fails it is rolled back and the existing data is unchanged. Attachment files
    are moved into place and the follow-up migrations run only after that transaction has committed, so they
    are reported separately and cannot undo or fail the restore.
    """
    if not _SAFE_BACKUP_NAME.match(filename):
        raise HTTPException(status_code=422, detail="Invalid backup filename")
    directory = backup_directory(settings)
    target = directory / filename
    if target.is_symlink() or target.resolve().parent != directory:
        raise HTTPException(status_code=422, detail="Invalid backup filename")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Backup file was not found")

    source: _Source | None = None
    staging: Path | None = None
    staged: dict[str, str] = {}
    renames: dict[str, str] = {}
    committed = False
    try:
        # ---- 1. Read and validate everything. Nothing in the database has been changed yet. ----
        try:
            source = _open_source(target)
            legacy = source.version == 1
            names = source.table_names()
            known = {table.name for table in _ordered_tables()}
            if legacy:
                expected = set(_LEGACY_TABLE_NAMES)
                missing_tables = sorted(expected - _LEGACY_OPTIONAL - names)
            else:
                expected = known
                missing_tables = sorted(expected - names)
            unknown = sorted(names - expected)
            if unknown:
                raise BackupError(f"The backup contains an unknown table ({unknown[0]}).")
            if missing_tables:
                raise BackupError(f"The backup is incomplete (missing table {missing_tables[0]}).")
            tables = _ordered_tables(expected)
            # Policy: a restore never commits or rolls back the caller's session (it uses its own connection), and
            # it refuses to start while that session has unsaved changes, which the restore would otherwise bypass.
            if session.new or session.dirty or session.deleted:
                raise HTTPException(
                    status_code=409, detail="The request has unsaved changes; save or discard them first. Nothing was changed."
                )
            # Read on a separate connection: the caller's session is neither started nor rolled back here.
            with engine.connect() as probe:
                user_ids = {value for (value,) in probe.execute(text("SELECT id FROM auth_users"))}
            context = _validate(source, tables, user_ids)
            staging, staged, missing_attachments = _stage_attachments(source, context.attachment_names)
            renames = {old: new for old, new in staged.items() if old != new}
        except BackupError as error:
            raise HTTPException(status_code=422, detail=f"The backup cannot be restored: {error} Nothing was changed.") from error

        # ---- 2. One transaction: lock, delete, insert, reset sequences, commit. ----
        warnings: list[str] = []
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

            captured = _inspect_inbound_references(connection, tables, warnings)
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
                lost = len(rows) - len(restored)
                if lost:
                    warnings.append(f"{lost} link(s) in {table.name}.{column.name} pointed to records that are not in the backup and were cleared.")
            transaction.commit()
            committed = True
        except HTTPException:
            _rollback(transaction)
            raise
        except BackupError as error:
            _rollback(transaction)
            raise HTTPException(
                status_code=422,
                detail=f"The backup cannot be restored: {error} The restore was rolled back; nothing was changed.",
            ) from error
        except DBAPIError as error:
            _rollback(transaction)
            reason = (str(getattr(error, "orig", None) or error).strip().splitlines() or ["database error"])[0][:300]
            if "lock timeout" in reason.lower() or "deadlock" in reason.lower():
                raise HTTPException(
                    status_code=409,
                    detail="The database is busy and the restore could not get exclusive access. Nothing was changed. Try again.",
                ) from error
            logger.exception("Restore failed and was rolled back")
            raise HTTPException(
                status_code=422,
                detail=f"The database rejected the backup data ({reason}). The restore was rolled back; nothing was changed.",
            ) from error
        except Exception:
            _rollback(transaction)
            logger.exception("Restore failed and was rolled back")
            raise HTTPException(
                status_code=500, detail="The restore failed and was rolled back; the existing data was not changed."
            ) from None
        finally:
            connection.close()

        # ---- 3. Committed. Everything below only completes the restore and reports on it. ----
        session.expire_all()  # sessions use expire_on_commit=False: drop objects loaded before the swap
        owners = {renames.get(old, old): owner for old, owner in context.attachment_documents.items()}
        failed_files, recovery_folder = _promote_attachments(staging, list(staged.values()), owners)
        staging = None  # either removed, or kept as the recovery folder
        warnings.extend(_report_warnings(context, missing_attachments, failed_files, len(renames), recovery_folder))
        warnings.extend(_post_restore_migrations(engine))
        logger.info(
            "Database restored from %s (format version %s); rows=%s; warnings=%s",
            filename, source.version, {name: count for name, count in context.counts.items() if count}, len(warnings),
        )
        return {
            "format_version": source.version,
            "rows": dict(context.counts),
            "files": len(staged) - len(failed_files),
            "failed_files": failed_files,
            "warnings": warnings,
        }
    finally:
        if source is not None:
            source.close()
        if staging is not None and not committed:
            shutil.rmtree(staging, ignore_errors=True)


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


def _inspect_inbound_references(connection: Connection, tables: list, warnings: list[str]) -> list:
    """Classify every foreign key from a table that is NOT replaced to a table that IS replaced.

    The delete of the replaced tables acts on those rows according to the key's ON DELETE rule:
      RESTRICT / NO ACTION  rows would block the restore -> refuse with a clear message (nothing changed);
      CASCADE               rows are deleted with their parent -> reported in the warnings;
      SET NULL              the link is cleared -> captured here and re-applied after the insert where the
                            parent exists again (single-column primary key); otherwise reported.
    Returns the captured links to re-apply.
    """
    replaced = set(tables)
    captured = []
    for table in Base.metadata.tables.values():
        if table in replaced:
            continue
        for fk in table.foreign_keys:
            if fk.column.table not in replaced:
                continue
            column, action = fk.parent, (fk.ondelete or "NO ACTION").upper()
            count = connection.execute(select(func.count()).select_from(table).where(column.is_not(None))).scalar() or 0
            if not count:
                continue
            pk = list(table.primary_key.columns)
            if action == "CASCADE":
                warnings.append(
                    f"{count} row(s) of {table.name} are removed together with the replaced data; "
                    "they are not part of this backup."
                )
            elif action == "SET NULL" and len(pk) == 1:
                captured.append((table, pk[0], column, fk.column,
                                 connection.execute(select(pk[0], column).where(column.is_not(None))).all()))
            elif action in ("SET NULL", "SET DEFAULT"):
                warnings.append(f"{count} link(s) in {table.name}.{column.name} are cleared by the restore.")
            else:
                raise BackupError(
                    f"{count} row(s) in {table.name} still refer to data that the restore replaces "
                    f"({column.name} -> {fk.column.table.name}, rule {action}). Remove or migrate them first."
                )
    return captured


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
