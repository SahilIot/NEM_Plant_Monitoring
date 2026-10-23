# connecting your FASTAPI backend to PostgreSQL, managing db sessions, and handling timestamps consistently in UTC
from datetime import datetime, timezone
from typing import Generator # describes a function that yields values.

from fastapi import HTTPException, Request
from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker, with_loader_criteria
from sqlalchemy.types import TypeDecorator

from app.core.config import get_settings, validate_postgresql_database_url

#this class customizes how SQLAlchemy converts timestamps between Python and the database.
class UTCDateTime(TypeDecorator[datetime]):
    """Expose aware UTC datetimes while storing UTC-naive timestamps."""

    impl = DateTime
    cache_ok = True
# sends datetime value to the db
    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None)
# reads a datetime from the database and converts it into a py value
    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

# engine that your backend uses to communicate with PostgreSQL 
def create_database_engine(database_url: str | None = None) -> Engine:
    url = get_settings().database_url if database_url is None else database_url
    validate_postgresql_database_url(url)
    return create_engine(url, pool_pre_ping=True)

# manage db connectivity. A session is the object through which your application queries and modifies db records
def create_session_factory(
    engine: Engine,
    *,
    info: dict[str, object] | None = None,
) -> sessionmaker[Session]:
    return sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
        info=info,
    )

# this function provides a db session to FastAPI endpoints
def get_db(request: Request) -> Generator[Session, None, None]:
    with request.app.state.session_factory() as session:
        user_id = getattr(request.state, "auth_user_id", None)
        if user_id is not None:
            session.info["auth_user_id"] = user_id
            session.info["auth_role"] = request.state.auth_role
            session.info["authorized_asset_ids"] = frozenset(
                request.state.authorized_asset_ids
            )
        yield session


@event.listens_for(Session, "do_orm_execute")
def _scope_queries_to_assigned_assets(execute_state) -> None:
    session = execute_state.session
    if session.info.get("auth_role") not in {"Operator", "Viewer"}:
        return
    if not (
        execute_state.is_select
        or execute_state.is_update
        or execute_state.is_delete
    ):
        return
    asset_ids = tuple(session.info.get("authorized_asset_ids", ()))
    if not asset_ids:
        asset_ids = (-1,)

    from app.models import (
        Alert,
        Asset,
        MachineMonitoringState,
        MaintenanceRecord,
        MaintenanceSchedule,
        MonitoringEvent,
        MonitoringRule,
        Reading,
        RuleCounterState,
        RuleState,
        Variable,
    )

    execute_state.statement = execute_state.statement.options(
        with_loader_criteria(Asset, Asset.id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(Variable, Variable.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(Reading, Reading.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(MonitoringRule, MonitoringRule.target_asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(RuleState, RuleState.target_asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(Alert, Alert.target_asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(MonitoringEvent, MonitoringEvent.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(MaintenanceRecord, MaintenanceRecord.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(MaintenanceSchedule, MaintenanceSchedule.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(MachineMonitoringState, MachineMonitoringState.asset_id.in_(asset_ids), include_aliases=True),
        with_loader_criteria(RuleCounterState, RuleCounterState.asset_id.in_(asset_ids), include_aliases=True),
    )


@event.listens_for(Session, "before_flush")
def _reject_unassigned_asset_writes(session: Session, flush_context, instances) -> None:
    if session.info.get("auth_role") in (None, "Admin"):
        return
    asset_ids = session.info.get("authorized_asset_ids", frozenset())

    from app.models import (
        Alert,
        Asset,
        MachineMonitoringState,
        MaintenanceRecord,
        MaintenanceSchedule,
        MonitoringEvent,
        MonitoringRule,
        Reading,
        RuleCounterState,
        RuleState,
        Variable,
    )

    asset_attributes = {
        Asset: "id",
        Variable: "asset_id",
        Reading: "asset_id",
        MonitoringRule: "target_asset_id",
        RuleState: "target_asset_id",
        Alert: "target_asset_id",
        MonitoringEvent: "asset_id",
        MaintenanceRecord: "asset_id",
        MaintenanceSchedule: "asset_id",
        MachineMonitoringState: "asset_id",
        RuleCounterState: "asset_id",
    }
    for instance in (*session.new, *session.dirty, *session.deleted):
        for model, attribute in asset_attributes.items():
            if isinstance(instance, model):
                asset_id = getattr(instance, attribute, None)
                if asset_id not in asset_ids:
                    raise HTTPException(
                        status_code=403,
                        detail="You do not have permission to modify this machine's data",
                    )
                break
