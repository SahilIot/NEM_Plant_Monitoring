import json
import logging
import re

from sqlalchemy import bindparam, inspect, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql import sqltypes
import app.models
from app.db.base import Base
from app.models import (
    FrontendConfig,
    MachineMonitoringState,
    MonitoringRule,
    MonitoringRuleTemplate,
    RuleCounterState,
    Variable,
)
from app.db.migrations.shared_labels import upgrade as upgrade_shared_labels

# Removes a db column only if that column currently exists.
def _drop_column_if_present(engine: Engine, table_name: str, column_name: str) -> None:
    columns = {
        column["name"]
        for column in inspect(engine).get_columns(table_name)
    }
    if column_name not in columns:
        return
    if engine.dialect.name != "postgresql":
        raise RuntimeError(f"Column removal is not implemented for {engine.dialect.name}")
    with engine.begin() as connection:
        connection.execute(text(f"ALTER TABLE {table_name} DROP COLUMN {column_name}"))


#creates tables defined in SQLAlchemy models if they do not exist
def _migrate_auth_roles(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE auth_users
                SET role = CASE role
                    WHEN 'Admin' THEN 'Administrator'
                    WHEN 'Viewer' THEN 'Supervisor'
                    ELSE role
                END
                WHERE role IN ('Admin', 'Viewer')
                """
            )
        )
        invalid_role = connection.execute(
            text(
                """
                SELECT id, role
                FROM auth_users
                WHERE role NOT IN ('Administrator', 'Supervisor', 'Operator')
                LIMIT 1
                """
            )
        ).first()
        if invalid_role is not None:
            raise RuntimeError(
                "Unsupported user role in auth_users "
                f"(user id {invalid_role.id}, role {invalid_role.role!r}); "
                "correct the role before starting the application"
            )

        if engine.dialect.name == "postgresql":
            check_constraints = inspect(connection).get_check_constraints("auth_users")
            if not any(constraint["name"] == "ck_auth_users_role" for constraint in check_constraints):
                connection.execute(
                    text(
                        "ALTER TABLE auth_users "
                        "ADD CONSTRAINT ck_auth_users_role "
                        "CHECK (role IN "
                        "('Administrator', 'Supervisor', 'Operator'))"
                    )
                )
        else:
            raise RuntimeError("User role migration is not implemented for "f"{engine.dialect.name}")

# Arbitrary constant shared by every process that upgrades this schema.
_SCHEMA_UPGRADE_LOCK_KEY = 0x4E454D01

# Main entry point
def initialize_database(engine: Engine) -> None:
    """Create/upgrade the schema. Safe to call repeatedly and from several processes.

    On PostgreSQL a session-level advisory lock serializes concurrent callers (API
    workers, create_admin.py, seed.py) so their DDL cannot interleave. The upgrade
    steps themselves are additive and idempotent.
    """
    if engine.dialect.name != "postgresql":
        _initialize_schema(engine)
        return
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as lock_connection:
        lock_connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _SCHEMA_UPGRADE_LOCK_KEY})
        try:
            _initialize_schema(engine)
        finally:
            lock_connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _SCHEMA_UPGRADE_LOCK_KEY})


_RULE_TYPES = ("parameter_threshold", "runtime_duration", "duration",
    "generic", "boolean_condition", "boolean_count_threshold",)

# This function checks whether an existing PostgreSQL db has the correct allowed rule types.
def _reconcile_rule_type_constraint(engine: Engine) -> None:
    """Widen ck_nem_monitoring_rules_type on databases created before every type existed.

    create_all() never alters an existing table, so an older database can keep a narrower
    constraint than the model declares. Rows already stored satisfy the wider list, and the
    constraint is added NOT VALID so no existing row is scanned, rejected or changed.
    """
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as connection:
        definition = connection.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_nem_monitoring_rules_type' "
            "AND conrelid = 'nem_monitoring_rules'::regclass"
        )).scalar()
        if definition is not None and all(f"'{name}'" in definition for name in _RULE_TYPES):
            return
        if definition is not None:
            connection.execute(text("ALTER TABLE nem_monitoring_rules DROP CONSTRAINT ck_nem_monitoring_rules_type"))
        allowed = ", ".join(f"'{name}'" for name in _RULE_TYPES)
        connection.execute(text("ALTER TABLE nem_monitoring_rules ADD CONSTRAINT ck_nem_monitoring_rules_type "
            f"CHECK (rule_type IN ({allowed})) NOT VALID"))

# Audit trail columns (who created / last modified a record). Additive and
# idempotent; existing rows keep NULL because their history is unknown.
_AUDIT_TABLES = (
    "nem_monitoring_rules",
    "nem_maintenance_schedules",
    "nem_maintenance_records",
    "instruction_documents",
)

logger = logging.getLogger(__name__)

_SAFE_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")
_POSTGRES_MAX_IDENTIFIER = 63
# How long a migration waits for a table lock before giving up until the next start.
_MIGRATION_LOCK_TIMEOUT = "5s"

_TEMPLATES_TABLE = "nem_monitoring_rule_templates"
_VISIBILITY_VALUES = ("admin_only", "specific_supervisors")
_OBSOLETE_VISIBILITY = "all_supervisors"
_VISIBILITY_DEFAULT = "admin_only"
_VISIBILITY_CHECK = "ck_nem_monitoring_rule_templates_visibility"
_REQUESTS_TABLE = "nem_rule_visibility_requests"
_CHANGES_TABLE = "nem_rule_visibility_changes"
_REQUEST_COLUMN = "request_id"


def _ident(engine: Engine, name: str) -> str:
    """Quote a fixed, code-defined table/column/index name; refuse anything else."""
    if not _SAFE_IDENTIFIER.match(name) or len(name) > _POSTGRES_MAX_IDENTIFIER:
        raise ValueError(f"Unsafe database identifier: {name!r}")
    return engine.dialect.identifier_preparer.quote(name)


def _is_postgresql(engine: Engine, step: str) -> bool:
    if engine.dialect.name == "postgresql":
        return True
    logger.warning("Skipping %s: the application database must be PostgreSQL (got %s).", step, engine.dialect.name)
    return False


def _index_name_taken(connection, name: str) -> bool:
    """True when any index with this name exists in the current schema (any table)."""
    return connection.execute(
        text("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = :name"),
        {"name": name},
    ).first() is not None


def _is_plain_index_on(index: dict, column: str) -> bool:
    """A usable audit index: single column, non-unique, not partial, not an expression."""
    options = index.get("dialect_options") or {}
    return (
        index.get("column_names") == [column]
        and not index.get("unique")
        and not index.get("expressions")
        and not any(key.endswith("_where") for key in options)
    )


def _ensure_single_column_index(connection, table: str, column: str) -> None:
    """Make sure a plain index on ``table(column)`` exists, judged by its definition, not its name."""
    if any(_is_plain_index_on(index, column) for index in inspect(connection).get_indexes(table)):
        return
    base = f"ix_{table}_{column}"
    for name in (base, f"{base}_audit"):
        if not _index_name_taken(connection, name):
            connection.execute(text(
                f"CREATE INDEX {_ident(connection.engine, name)} "
                f"ON {_ident(connection.engine, table)} ({_ident(connection.engine, column)})"
            ))
            return
    logger.warning("Could not index %s.%s: both %s and %s_audit are taken by other definitions.",
        table, column, base, base)


def _ensure_user_foreign_key(connection, table: str, column: str) -> None:
    """Check ``table.column`` references auth_users(id); repair it only where that is lossless."""
    foreign_keys = [
        fk for fk in inspect(connection).get_foreign_keys(table)
        if fk["constrained_columns"] == [column]
    ]
    matching = [
        fk for fk in foreign_keys
        if fk["referred_table"] == "auth_users" and fk["referred_columns"] == ["id"]
    ]
    if matching:
        ondelete = ((matching[0].get("options") or {}).get("ondelete") or "").upper()
        if ondelete != "SET NULL":
            logger.warning("%s.%s references auth_users but is ON DELETE %s instead of SET NULL; "
                "left unchanged.", table, column, ondelete or "NO ACTION")
        return
    if foreign_keys:
        logger.warning("%s.%s already references %s; left unchanged.", table, column,
            foreign_keys[0]["referred_table"])
        return
    engine = connection.engine
    quoted_table, quoted_column = _ident(engine, table), _ident(engine, column)
    orphans = connection.execute(text(
        f"SELECT COUNT(*) FROM {quoted_table} WHERE {quoted_column} IS NOT NULL "
        f"AND {quoted_column} NOT IN (SELECT id FROM auth_users)"
    )).scalar_one()
    if orphans:
        logger.warning("%s.%s has %s value(s) that match no auth_users row; the foreign key was not "
            "added and the data was left unchanged.", table, column, orphans)
        return
    constraint = f"fk_{table}_{column}_auth_users"
    connection.execute(text(
        f"ALTER TABLE {quoted_table} ADD CONSTRAINT {_ident(engine, constraint)} "
        f"FOREIGN KEY ({quoted_column}) REFERENCES auth_users (id) ON DELETE SET NULL"
    ))


def _ensure_user_reference_column(engine: Engine, table: str, column: str) -> None:
    """Ensure ``table.column`` is a nullable INTEGER FK to auth_users(id) ON DELETE SET NULL with an index.

    Missing pieces are added; existing columns and their data are never altered or deleted.
    One transaction per column, so a failure leaves nothing half-applied.
    """
    quoted_table, quoted_column = _ident(engine, table), _ident(engine, column)
    with engine.begin() as connection:
        columns = {col["name"]: col for col in inspect(connection).get_columns(table)}
        if column not in columns:
            connection.execute(text(
                f"ALTER TABLE {quoted_table} ADD COLUMN IF NOT EXISTS {quoted_column} INTEGER "
                "REFERENCES auth_users(id) ON DELETE SET NULL"
            ))
        elif not isinstance(columns[column]["type"], sqltypes.Integer):
            logger.warning("%s.%s is %s, not INTEGER; its foreign key and index were not touched.",
                table, column, columns[column]["type"])
            return
        else:
            _ensure_user_foreign_key(connection, table, column)
        _ensure_single_column_index(connection, table, column)


def _ensure_timestamp_column(engine: Engine, table: str, column: str) -> None:
    # Add a nullable naive-UTC timestamp column (matches the models' UTCDateTime) when missing
    with engine.begin() as connection:
        columns = {col["name"]: col for col in inspect(connection).get_columns(table)}
        if column not in columns:
            connection.execute(text(
                f"ALTER TABLE {_ident(engine, table)} ADD COLUMN IF NOT EXISTS "
                f"{_ident(engine, column)} TIMESTAMP WITHOUT TIME ZONE"
            ))


def _ensure_entry_type_column(engine: Engine, table: str) -> None:
    # Additive: existing rows become "document"; legacy "Instruction" rows are recognised when serialised.
    with engine.begin() as connection:
        columns = {col["name"] for col in inspect(connection).get_columns(table)}
        if "entry_type" not in columns:
            connection.execute(text(
                f"ALTER TABLE {_ident(engine, table)} ADD COLUMN IF NOT EXISTS entry_type "
                "VARCHAR(20) NOT NULL DEFAULT 'document'"
            ))


def _ensure_asset_reference_column(engine: Engine, table: str, column: str) -> None:
    # Add a nullable INTEGER FK to assets(id) ON DELETE SET NULL with an index when missing; never alters data.
    with engine.begin() as connection:
        columns = {col["name"]: col for col in inspect(connection).get_columns(table)}
        if column not in columns:
            connection.execute(text(
                f"ALTER TABLE {_ident(engine, table)} ADD COLUMN IF NOT EXISTS {_ident(engine, column)} "
                "INTEGER REFERENCES assets(id) ON DELETE SET NULL"
            ))
        _ensure_single_column_index(connection, table, column)


# add missing audit columns to tables that should have them, and create indexes on those columns
def _upgrade_audit_columns(engine: Engine) -> None:
    """Add/verify created_by_id, updated_by_id (FK to auth_users, indexed) and records.updated_at.
    Additive and idempotent: existing rows keep their values (NULL where history is unknown).
    """
    if not _is_postgresql(engine, "audit column upgrade"):
        return
    table_names = set(inspect(engine).get_table_names())
    if "auth_users" not in table_names:
        logger.info("Audit column upgrade skipped: auth_users does not exist yet.")
        return
    for table in _AUDIT_TABLES:
        if table not in table_names:
            continue
        for column in ("created_by_id", "updated_by_id"):
            _ensure_user_reference_column(engine, table, column)
        if table == "nem_maintenance_records":
            _ensure_timestamp_column(engine, table, "updated_at")
        if table == "instruction_documents":
            for column in ("created_at", "updated_at"):
                _ensure_timestamp_column(engine, table, column)
            if "assets" in table_names:
                _ensure_asset_reference_column(engine, table, "asset_id")
            _ensure_entry_type_column(engine, table)
    _warn_timezone_aware_audit_columns(engine, table_names)


def _warn_timezone_aware_audit_columns(engine: Engine, table_names: set[str]) -> None:
    # Read-only check. The models store naive UTC, so a TIMESTAMP WITH TIME ZONE audit column
    # holds values that may be shifted by the server time zone in force when they were written.
    inspector = inspect(engine)
    for table in _AUDIT_TABLES:
        if table not in table_names:
            continue
        for column in inspector.get_columns(table):
            if column["name"] in ("created_at", "updated_at") and getattr(column["type"], "timezone", False):
                logger.warning("%s.%s is TIMESTAMP WITH TIME ZONE but the models store naive UTC. "
                    "Rows written before connections were pinned to UTC may be shifted by the server's "
                    "UTC offset at write time; nothing was changed. Review them before correcting.",
                    table, column["name"])


def _constraint_literals(sqltext: str | None) -> set[str]:
    return set(re.findall(r"'([^']*)'", sqltext or ""))


def _normalise_invalid_visibility(connection) -> None:
    # Fail closed: unknown/NULL visibility values become admin_only (already invisible to Supervisors).
    table = _ident(connection.engine, _TEMPLATES_TABLE)
    invalid = connection.execute(
        text(f"SELECT id, visibility_type FROM {table} "
             "WHERE visibility_type IS NULL OR visibility_type NOT IN :valid")
        .bindparams(bindparam("valid", expanding=True)),
        {"valid": list(_VISIBILITY_VALUES)},
    ).all()
    if not invalid:
        return
    logger.warning(
        "%s shared rule(s) had an invalid visibility_type and were reset to %s (they were already "
        "hidden from Supervisors). Affected (id, old value): %s",
        len(invalid), _VISIBILITY_DEFAULT, [(row[0], row[1]) for row in invalid[:50]],
    )
    connection.execute(
        text(f"UPDATE {table} SET visibility_type = :value WHERE id = :id"),
        [{"value": _VISIBILITY_DEFAULT, "id": row[0]} for row in invalid],
    )


def _convert_obsolete_all_supervisors(connection) -> None:
    """Retire the removed "all_supervisors" visibility without changing who can see a rule.
    Each affected shared rule becomes ``specific_supervisors`` listing the Supervisors that are
    active right now (exactly the people who could see it before), or admin_only when there is
    none. A history row records the conversion. Idempotent: once converted
    no row carries the obsolete value.
    """
    names = set(inspect(connection).get_table_names())
    needed = {_TEMPLATES_TABLE, "nem_rule_template_supervisors", "nem_rule_visibility_changes", "auth_users"}
    templates = _ident(connection.engine, _TEMPLATES_TABLE)
    affected = [row[0] for row in connection.execute(
        text(f"SELECT id FROM {templates} WHERE visibility_type = :old ORDER BY id"),
        {"old": _OBSOLETE_VISIBILITY},
    )]
    if not affected:
        return
    if not needed <= names:
        raise RuntimeError(
            "Cannot retire all_supervisors visibility safely; missing tables: "
            + ", ".join(sorted(needed - names)))
    supervisors = [row[0] for row in connection.execute(text(
        "SELECT id FROM auth_users WHERE role = 'Supervisor' AND is_active = TRUE ORDER BY id"))]
    new_type = "specific_supervisors" if supervisors else _VISIBILITY_DEFAULT
    logger.warning(
        "Converting %s shared rule(s) from the removed all_supervisors visibility to %s "
        "(%s active Supervisor(s) keep access). Rule ids: %s",
        len(affected), new_type, len(supervisors), affected[:50],
    )
    for template_id in affected:
        if supervisors:
            connection.execute(
                text("INSERT INTO nem_rule_template_supervisors (template_id, user_id) "
                     "VALUES (:t, :u) ON CONFLICT DO NOTHING"),
                [{"t": template_id, "u": user_id} for user_id in supervisors],
            )
        connection.execute(
            text(f"UPDATE {templates} SET visibility_type = :new WHERE id = :id"),
            {"new": new_type, "id": template_id},
        )
        connection.execute(
            text("INSERT INTO nem_rule_visibility_changes (template_id, changed_by_id, source, "
                 "previous_visibility, new_visibility, previous_user_ids, new_user_ids, changed_at) "
                 "VALUES (:t, NULL, 'migration', :old, :new, CAST(:prev AS JSON), CAST(:ids AS JSON), now())"),
            {"t": template_id, "old": _OBSOLETE_VISIBILITY, "new": new_type,
             "prev": "[]", "ids": json.dumps(supervisors)},
        )

# This function ensures the shared - template table has a correctly config. visibility_type coluumn.
def _ensure_visibility_column(connection) -> None:
    # Add visibility_type (NOT NULL DEFAULT admin_only), or restore a missing default / NOT NULL.
    table = _ident(connection.engine, _TEMPLATES_TABLE)
    columns = {col["name"]: col for col in inspect(connection).get_columns(_TEMPLATES_TABLE)}
    if "visibility_type" not in columns:
        connection.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS visibility_type "
            f"VARCHAR(30) NOT NULL DEFAULT '{_VISIBILITY_DEFAULT}'"
        ))
        return
    column = columns["visibility_type"]
    if _VISIBILITY_DEFAULT not in str(column.get("default") or ""):
        connection.execute(text( f"ALTER TABLE {table} ALTER COLUMN visibility_type SET DEFAULT '{_VISIBILITY_DEFAULT}'"))
    if column.get("nullable"):
        _normalise_invalid_visibility(connection)
        connection.execute(text(f"ALTER TABLE {table} ALTER COLUMN visibility_type SET NOT NULL"))


def _ensure_visibility_check(connection) -> None:
    # Enforce the two allowed visibility values with a CHECK constraint (replacing a stale one).
    engine = connection.engine
    table = _ident(engine, _TEMPLATES_TABLE)
    # The inspector is scoped to this table in the connection's default schema, so a same-named
    # constraint on another table or schema is never mistaken for this one.
    checks = {c["name"]: c for c in inspect(connection).get_check_constraints(_TEMPLATES_TABLE)}
    existing = checks.get(_VISIBILITY_CHECK)
    if existing is not None and _constraint_literals(existing.get("sqltext")) == set(_VISIBILITY_VALUES):
        return
    if existing is not None:
        logger.warning("%s has a different definition than expected; replacing it.", _VISIBILITY_CHECK)
        connection.execute(text(f"ALTER TABLE {table} DROP CONSTRAINT {_ident(engine, _VISIBILITY_CHECK)}"))
    values = ", ".join(f"'{value}'" for value in _VISIBILITY_VALUES)
    connection.execute(text(
        f"ALTER TABLE {table} ADD CONSTRAINT {_ident(engine, _VISIBILITY_CHECK)} "
        f"CHECK (visibility_type IN ({values}))"
    ))


# Adds visibility_type default is admin only can change to specific supervisors or all supervisors.
def _upgrade_rule_visibility(engine: Engine) -> None:
    """Add shared-rule visibility and template audit columns (idempotent, additive).
    Existing shared rules default to ``admin_only``; valid existing values are preserved and no
    historical permission is invented. Invalid values are reset to ``admin_only`` (fail closed)
    before the allowed-values constraint is enforced.
    """
    if not _is_postgresql(engine, "rule visibility upgrade"):
        return
    table_names = set(inspect(engine).get_table_names())
    if _TEMPLATES_TABLE not in table_names:
        return
    with engine.begin() as connection:
        _ensure_visibility_column(connection)
        _convert_obsolete_all_supervisors(connection)
        _normalise_invalid_visibility(connection)
        _ensure_visibility_check(connection)
    if "auth_users" not in table_names:
        logger.info("Template audit columns skipped: auth_users does not exist yet.")
        return
    for column in ("created_by_id", "updated_by_id"):
        _ensure_user_reference_column(engine, _TEMPLATES_TABLE, column)


def _request_cleanup_blockers(connection) -> list[str]:
    """Reasons the obsolete request structures must be kept (empty list = safe to remove)."""
    inspector = inspect(connection)
    names = set(inspector.get_table_names())
    blockers: list[str] = []
    for table in sorted(names):
        for fk in inspector.get_foreign_keys(table):
            if fk["referred_table"] == _REQUESTS_TABLE and not (
                table == _CHANGES_TABLE and fk["constrained_columns"] == [_REQUEST_COLUMN]
            ):
                blockers.append(f"unexpected foreign key {table}({', '.join(fk['constrained_columns'])})")
    engine = connection.engine
    if _REQUESTS_TABLE in names:
        count = connection.execute(text(f"SELECT COUNT(*) FROM {_ident(engine, _REQUESTS_TABLE)}")).scalar_one()
        if count:
            blockers.append(f"{count} old request record(s) in {_REQUESTS_TABLE}")
    if _CHANGES_TABLE in names and _REQUEST_COLUMN in {c["name"] for c in inspector.get_columns(_CHANGES_TABLE)}:
        linked = connection.execute(text(
            f"SELECT COUNT(*) FROM {_ident(engine, _CHANGES_TABLE)} WHERE {_ident(engine, _REQUEST_COLUMN)} IS NOT NULL"
        )).scalar_one()
        if linked:
            blockers.append(f"{linked} visibility change(s) still linked through {_CHANGES_TABLE}.{_REQUEST_COLUMN}")
    return blockers


# Remove the discontinued visibility-request structures, but only when that loses nothing.
def _remove_visibility_requests(engine: Engine) -> None:
    """Drop ``nem_rule_visibility_requests`` and ``nem_rule_visibility_changes.request_id``.

    Both are removed together, atomically, and only when the request table is empty, nothing
    else references it, and no change row still points at a request. Otherwise everything is kept
    and a warning explains why. Re-running is harmless, and each structure is handled
    independently, so a database left half-migrated converges on the next start.
    """
    if not _is_postgresql(engine, "visibility-request removal"):
        return
    inspector = inspect(engine)
    names = set(inspector.get_table_names())
    has_column = _CHANGES_TABLE in names and _REQUEST_COLUMN in {
        column["name"] for column in inspector.get_columns(_CHANGES_TABLE)
    }
    if _REQUESTS_TABLE not in names and not has_column:
        return
    try:
        with engine.begin() as connection:
            connection.execute(text(f"SET LOCAL lock_timeout = '{_MIGRATION_LOCK_TIMEOUT}'"))
            names = set(inspect(connection).get_table_names())
            locked = [_ident(engine, t) for t in (_CHANGES_TABLE, _REQUESTS_TABLE) if t in names]
            if not locked:
                return
            # Block writers on both tables until commit, so a row cannot appear between the emptiness
            # check below and the drop. A fixed lock order avoids deadlocks between migrations.
            connection.execute(text(f"LOCK TABLE {', '.join(locked)} IN ACCESS EXCLUSIVE MODE"))
            blockers = _request_cleanup_blockers(connection)
            if blockers:
                logger.warning("Obsolete visibility-request structures were kept: %s. They are no longer "
                    "used; remove them manually once the history is no longer needed.", "; ".join(blockers))
                return
            if _CHANGES_TABLE in names:
                connection.execute(text(
                    f"ALTER TABLE {_ident(engine, _CHANGES_TABLE)} DROP COLUMN IF EXISTS {_ident(engine, _REQUEST_COLUMN)}"))
            if _REQUESTS_TABLE in names:
                # No CASCADE: PostgreSQL itself refuses if a view or foreign key still depends on it.
                connection.execute(text(f"DROP TABLE {_ident(engine, _REQUESTS_TABLE)}"))
            logger.info("Removed the obsolete visibility-request table and %s.%s.", _CHANGES_TABLE, _REQUEST_COLUMN)
    except SQLAlchemyError as exc:
        # The structures are unused, so a busy or blocked database must not stop the application
        # from starting; nothing was changed (the transaction rolled back) and the next start retries.
        logger.warning("Could not remove the obsolete visibility-request structures yet (they were "
            "left unchanged and will be retried at the next start): %s", exc)


# Largest and important function this creates missing tables and other supported objects described in the SQLAlchemy models.
def _initialize_schema(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_auth_roles(engine)
    _upgrade_audit_columns(engine)
    _upgrade_rule_visibility(engine)
    _remove_visibility_requests(engine)
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "auth_users" in table_names:
        auth_columns = {column["name"] for column in inspector.get_columns("auth_users")}
        with engine.begin() as connection:
            if "contact_number" not in auth_columns:
                connection.execute(text("ALTER TABLE auth_users ADD COLUMN contact_number VARCHAR(20)"))
            if "email_address" not in auth_columns:
                connection.execute(text("ALTER TABLE auth_users ADD COLUMN email_address VARCHAR(254)"))
    if "nem_monitoring_rule_templates" in table_names:
        template_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rule_templates")
        }
        if "collection_id" not in template_columns:
            with engine.begin() as connection:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                        "ALTER TABLE nem_monitoring_rule_templates "
                        "ADD COLUMN IF NOT EXISTS collection_id INTEGER "
                        "REFERENCES rule_collections(id) ON DELETE SET NULL"
                    ))
                else:
                    connection.execute(text(
                        "ALTER TABLE nem_monitoring_rule_templates "
                        "ADD COLUMN collection_id INTEGER "
                        "REFERENCES rule_collections(id) ON DELETE SET NULL"
                    ))
        with engine.begin() as connection:
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_nem_monitoring_rule_templates_collection_id "
                "ON nem_monitoring_rule_templates (collection_id)"
            ))
    if "nem_monitoring_rule_template_requests" in table_names:
        request_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_monitoring_rule_template_requests"
            )
        }
        with engine.begin() as connection:
            if "suggestion_type" not in request_columns:
                connection.execute(
                    text(
                        "ALTER TABLE nem_monitoring_rule_template_requests "
                        "ADD COLUMN suggestion_type VARCHAR(30) NOT NULL "
                        "DEFAULT 'monitoring_rule'"
                    )
                )
            if "maintenance_details" not in request_columns:
                connection.execute(text(
                        "ALTER TABLE nem_monitoring_rule_template_requests "
                        "ADD COLUMN maintenance_details JSON"
                    )
                )
    if "instruction_documents" in table_names:
        document_columns = {
            column["name"]
            for column in inspector.get_columns("instruction_documents")
        }
        with engine.begin() as connection:
            if "labels" not in document_columns:
                connection.execute(text(
                        "ALTER TABLE instruction_documents "
                        "ADD COLUMN labels JSON NOT NULL DEFAULT '[]'"
                    )
                )
            if "duration_minutes" not in document_columns:
                connection.execute(text(
                        "ALTER TABLE instruction_documents "
                        "ADD COLUMN duration_minutes INTEGER"
                    )
                )

    if "variables" in table_names:
        variable_columns = {column["name"] for column in inspector.get_columns("variables")}
        if "opcua_node_id" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE variables "
                        "ADD COLUMN opcua_node_id VARCHAR(512)"
                    )
                )
        if "signal_role" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE variables ADD COLUMN signal_role VARCHAR(20)"))
        with engine.begin() as connection:
            connection.execute(text("DROP INDEX IF EXISTS uq_variables_opcua_node_id"))
            connection.execute(text("DROP INDEX IF EXISTS ix_variables_opcua_node_id"))
            connection.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_variables_opcua_node_id "
                    "ON variables (opcua_node_id)"
                )
            )
    if "nem_monitoring_rules" in table_names:
        rule_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }
        with engine.begin() as connection:
            if "lifecycle_status" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS lifecycle_status "
                            "VARCHAR(20) NOT NULL DEFAULT 'deactivated'"
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN lifecycle_status "
                            "VARCHAR(20) NOT NULL DEFAULT 'deactivated'"
                        )
                    )
                connection.execute(text(
                        "UPDATE nem_monitoring_rules SET lifecycle_status = "
                        "CASE WHEN is_enabled = TRUE "
                        "THEN 'in_progress' ELSE 'deactivated' END"
                    )
                )
            if "completed_at" not in rule_columns:
                column_type = ("TIMESTAMP WITH TIME ZONE"
                    if engine.dialect.name == "postgresql"
                    else "DATETIME"
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(text("ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS completed_at "
                            + column_type
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN completed_at " + column_type
                        )
                    )
            if "source_template_id" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
            connection.execute(text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_nem_monitoring_rules_source_template_id "
                    "ON nem_monitoring_rules (source_template_id)"
                )
            )
        _drop_column_if_present(engine, "nem_monitoring_rules", "is_archived")
    if "nem_monitoring_rules" in table_names:
        _reconcile_rule_type_constraint(engine)
    _migrate_legacy_rule_templates(engine)
    _migrate_boolean_duration_templates(engine)
    _migrate_existing_rule_counters(engine)
    upgrade_shared_labels(engine)

    if "nem_maintenance_schedules" in table_names:
        schedule_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_schedules"
            )
        }

        if "instruction_document_ids" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE nem_maintenance_schedules "
                        "ADD COLUMN instruction_document_ids JSON NOT NULL DEFAULT '[]'"
                    )
                )

        if "current_period_start_date" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE nem_maintenance_schedules "
                        "ADD COLUMN current_period_start_date DATE"
                    )
                )

                connection.execute(
                    text(
                        "UPDATE nem_maintenance_schedules "
                        "SET current_period_start_date = schedule_start_date "
                        "WHERE current_period_start_date IS NULL"
                    )
                )

                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_schedules "
                            "ALTER COLUMN current_period_start_date SET NOT NULL"
                        )
                    )

        
        # Add runtime- and usage-based maintenance scheduling fields.
        schedule_column_definitions = {
            "schedule_mode": "VARCHAR(20) NOT NULL DEFAULT 'calendar'",
            "signal_variable_id": (
                "INTEGER REFERENCES variables(id) ON DELETE RESTRICT"
            ),
            "runtime_interval_hours": "FLOAT",
            "usage_interval_count": "INTEGER",
            "current_progress": "FLOAT NOT NULL DEFAULT 0",
            "last_signal_value": "BOOLEAN",
            "last_signal_at": "TIMESTAMP",
        }

        with engine.begin() as connection:
            for name, definition in schedule_column_definitions.items():
                if name not in schedule_columns:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_schedules "
                            f"ADD COLUMN {name} {definition}"
                        )
                    )

            # Create the signal variable lookup index.
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_nem_maintenance_schedules_signal_variable_id "
                    "ON nem_maintenance_schedules (signal_variable_id)"
                )
            )

            # Add scheduling constraints only when they do not already exist.
            if engine.dialect.name == "postgresql":
                schedule_constraints = {
                    "ck_maintenance_schedule_mode": (
                        "CHECK (schedule_mode IN ('calendar', 'runtime', 'usage'))"
                    ),
                    "ck_maintenance_schedule_runtime_interval": (
                        "CHECK (runtime_interval_hours IS NULL "
                        "OR runtime_interval_hours > 0)"
                    ),
                    "ck_maintenance_schedule_usage_interval": (
                        "CHECK (usage_interval_count IS NULL "
                        "OR usage_interval_count > 0)"
                    ),
                    "ck_maintenance_schedule_progress": (
                        "CHECK (current_progress >= 0)"
                    ),
                }

                existing_constraints = {
                    row[0]
                    for row in connection.execute(
                        text("""
                            SELECT conname
                            FROM pg_constraint
                            WHERE conrelid =
                                'nem_maintenance_schedules'::regclass
                        """)
                    ).fetchall()
                }

                for constraint_name, definition in schedule_constraints.items():
                    if constraint_name not in existing_constraints:
                        connection.execute(
                            text(
                                "ALTER TABLE nem_maintenance_schedules "
                                f"ADD CONSTRAINT {constraint_name} {definition} "
                                "NOT VALID"
                            )
                        )
                
    if "nem_maintenance_records" in table_names:
        record_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_records"
            )
        }
        record_column_definitions = {
            "maintenance_type": "VARCHAR(30) NOT NULL DEFAULT 'inspection'",
            "status": "VARCHAR(20) NOT NULL DEFAULT 'completed'",
            "planned_start_at": "TIMESTAMP",
            "planned_end_at": "TIMESTAMP",
            "actual_started_at": "TIMESTAMP",
            "actual_completed_at": "TIMESTAMP",
            "priority": "VARCHAR(20) NOT NULL DEFAULT 'medium'",
            "assigned_technician": "VARCHAR(200)",
            "completion_notes": "TEXT",
            "parts_used": "TEXT",
            "checklist": "JSON",
            "schedule_id": (
                "INTEGER REFERENCES nem_maintenance_schedules(id) "
                "ON DELETE RESTRICT"
            ),
            "planned_due_date": "DATE",
        }
        with engine.begin() as connection:
            for name, definition in record_column_definitions.items():
                if name not in record_columns:
                    connection.execute(text("ALTER TABLE nem_maintenance_records "
                            f"ADD COLUMN {name} {definition}"
                        )
                    )
            connection.execute(text(
                    "UPDATE nem_maintenance_records "
                    "SET actual_completed_at = performed_at "
                    "WHERE status = 'completed' AND actual_completed_at IS NULL"
                )
            )
        _drop_column_if_present(
            engine,
            "nem_maintenance_records",
            "archived_at",
        )
        record_inspector = inspect(engine)
        has_occurrence_unique = any(
            constraint.get("name") == "uq_maintenance_occurrence_schedule_due"
            for constraint in record_inspector.get_unique_constraints("nem_maintenance_records")
        ) or any(
            index.get("name") == "uq_maintenance_occurrence_schedule_due"
            and index.get("unique")
            for index in record_inspector.get_indexes("nem_maintenance_records")
        )
        if not has_occurrence_unique:
            with engine.begin() as connection:
                duplicate = connection.execute(
                    text(
                        "SELECT schedule_id, planned_due_date, COUNT(*) "
                        "FROM nem_maintenance_records "
                        "WHERE schedule_id IS NOT NULL "
                        "AND planned_due_date IS NOT NULL "
                        "GROUP BY schedule_id, planned_due_date "
                        "HAVING COUNT(*) > 1 LIMIT 1"
                    )
                ).first()
                if duplicate is not None:
                    raise RuntimeError(
                        "Cannot enable recurring occurrence uniqueness: "
                        "duplicate scheduled maintenance records exist for "
                        f"schedule {duplicate.schedule_id} on {duplicate.planned_due_date}."
                    )
                connection.execute(
                    text(
                            "CREATE UNIQUE INDEX IF NOT EXISTS "
                            "uq_maintenance_occurrence_schedule_due "
                            "ON nem_maintenance_records (schedule_id, planned_due_date)"
                        )
                    )

    if "nem_alerts" in table_names and "nem_maintenance_schedules" in table_names:
        alert_columns = {column["name"] for column in inspect(engine).get_columns("nem_alerts")}

        with engine.begin() as connection:
            if "maintenance_schedule_id" not in alert_columns:
                connection.execute(text("ALTER TABLE nem_alerts ADD COLUMN maintenance_schedule_id INTEGER"))
            if "maintenance_due_date" not in alert_columns:
                connection.execute(text("ALTER TABLE nem_alerts "
                        "ADD COLUMN maintenance_due_date DATE"
                    )
                )

            if engine.dialect.name == "postgresql":
                connection.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'fk_nem_alerts_maintenance_schedule') "
                        "THEN ALTER TABLE nem_alerts "
                        "ADD CONSTRAINT fk_nem_alerts_maintenance_schedule "
                        "FOREIGN KEY (maintenance_schedule_id) "
                        "REFERENCES nem_maintenance_schedules(id) "
                        "ON DELETE RESTRICT; END IF; END $$"
                    )
                )
                connection.execute(text(
                        "CREATE INDEX IF NOT EXISTS "
                        "ix_nem_alerts_maintenance_schedule_id "
                        "ON nem_alerts (maintenance_schedule_id)"
                    )
                )
                connection.execute(text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS "
                        "uq_nem_alerts_active_maintenance_due "
                        "ON nem_alerts (maintenance_schedule_id, maintenance_due_date) "
                        "WHERE status = 'active' "
                        "AND maintenance_schedule_id IS NOT NULL"
                    )
                )
                connection.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'ck_nem_alerts_source') "
                        "THEN ALTER TABLE nem_alerts "
                        "ADD CONSTRAINT ck_nem_alerts_source CHECK ("
                        "(rule_id IS NOT NULL AND maintenance_schedule_id IS NULL) "
                        "OR (rule_id IS NULL AND maintenance_schedule_id IS NOT NULL "
                        "AND maintenance_due_date IS NOT NULL)); "
                        "END IF; END $$"
                    )
                )
#converts qualifying older rules into resuable templates
def _migrate_legacy_rule_templates(engine: Engine) -> None:
    supported_types = {
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "boolean_count_threshold",
    }
    type_map = {
        "number": ["number"],
        "integer": ["integer"],
        "boolean": ["boolean"],
        "string": ["string"],
    }
    with Session(engine) as session:
        legacy_rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.target_asset_id.is_(None),
                MonitoringRule.rule_type.in_(supported_types),
            )
        ).all()
        for rule in legacy_rules:
            if session.scalar(
                select(MonitoringRuleTemplate.id).where(
                    MonitoringRuleTemplate.legacy_rule_id == rule.id
                )
            ):
                continue
            variable = (
                session.get(Variable, rule.variable_id)
                if rule.variable_id is not None
                else None
            )
            required_types = (type_map.get(variable.data_type) if variable is not None else None)
            if rule.rule_type == "parameter_threshold" and required_types is None:
                required_types = ["number", "integer"]
            elif rule.rule_type == "boolean_count_threshold":
                required_types = ["boolean"]
            elif rule.rule_type == "duration" and required_types is None:
                required_types = ["number", "integer"]

            session.add(
                MonitoringRuleTemplate(
                    name=rule.name,
                    description=rule.description,
                    rule_type=rule.rule_type,
                    required_variable_types=required_types,
                    variable_key=variable.key if variable else None,
                    operator=rule.operator,
                    threshold=rule.threshold,
                    parameters=rule.parameters,
                    severity=rule.severity,
                    is_enabled=rule.is_enabled,
                    evaluation_interval_seconds=rule.evaluation_interval_seconds,
                    stale_after_seconds=rule.stale_after_seconds,
                    legacy_rule_id=rule.id,
                )
            )
            rule.is_enabled = False
        session.commit()

#fixes old duration-rule templates 
def _migrate_boolean_duration_templates(engine: Engine) -> None:
    with Session(engine) as session:
        templates = session.scalars(
            select(MonitoringRuleTemplate).where(
                MonitoringRuleTemplate.rule_type == "duration"
            )
        ).all()
        for template in templates:
            parameters = dict(template.parameters or {})
            if (
                parameters.get("condition") != "threshold"
                or "boolean" not in (template.required_variable_types or [])
            ):
                continue
            parameters["condition"] = "equals"
            parameters["expected_value"] = True
            parameters.pop("operator", None)
            parameters.pop("threshold", None)
            template.parameters = parameters
        session.commit()

#intializes counter-tracking records for existing boolean count-threshold rules
def _migrate_existing_rule_counters(engine: Engine) -> None:
    migration_key = "internal_rule_counter_state_v1"
    insert_function = pg_insert
    with Session(engine) as session:
        statement = (
            insert_function(FrontendConfig)
            .values(key=migration_key, value={"complete": True})
            .on_conflict_do_nothing(index_elements=[FrontendConfig.key])
            .returning(FrontendConfig.key)
        )
        inserted = session.scalar(statement)
        if inserted is None:
            session.rollback()
            return
#Find existing rules that need counter state
        rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.rule_type == "boolean_count_threshold",
                MonitoringRule.target_asset_id.is_not(None),
            )
        ).all()
        for rule in rules:
            #Retrieve the machine`s current state`
            machine_state = session.get(MachineMonitoringState, rule.target_asset_id)
            #Create a counter-state record 
            session.add(
                RuleCounterState(
                    rule_id=rule.id,
                    asset_id=rule.target_asset_id,
                    cycle_count=machine_state.cycle_count if machine_state else 0,
                    cycle_signal=machine_state.cycle_signal if machine_state else None,
                    last_signal_at=(machine_state.last_cycle_signal_at
                        if machine_state
                        else None
                    ),
                    updated_at=(machine_state.updated_at
                        if machine_state
                        else rule.created_at
                    ),
                )
            )
        session.commit()