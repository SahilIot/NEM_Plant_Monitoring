# Maintenance API routes for creating, listing, and retrieving maintenance records.
# Work with timestamps and utc time
from datetime import datetime, timezone
#APIRouter -> Groups maintenance endpoints
#Depends-> Injects the database session
#HTTPException-> Raises HTTP errors such as 404,422 etc
#Query-> Defines query-parameter validation and defaults
#status-> Provides Https status code
from fastapi import APIRouter, Depends, HTTPException, Query, status
#func, select-> Provides SQL functions and count records
from sqlalchemy import func, select
#Session-> Represents a database session for interacting with the database
from sqlalchemy.orm import Session
#get_db-> Provides a database session
from app.db.session import get_db
#Assest -> Represents a machine or monitored asset,Alert-> Represents an alert associted with an asset,MaintenanceRecord-> Represents a saved  maintenance record for an asset
from app.models import Alert, Asset, MaintenanceRecord
# MaintenanceRecord -> Represents a saved maintenance record, MaintenanceRead -> Defines the response structure
from app.schemas.maintenance import MaintenanceCreate, MaintenanceRead
# emit_event -> Publishes a maintenance event , utc_now-> current UTC time
from app.services.monitoring_engine import emit_event, utc_now

# API router
router = APIRouter(prefix="/maintenance", tags=["maintenance"])

# Handling time zones
def normalized(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

 # Creating a maintenance record main function for saving a maintenance record
@router.post("", response_model=MaintenanceRead, status_code=status.HTTP_201_CREATED)
def create_maintenance_record(
    payload: MaintenanceCreate,
    session: Session = Depends(get_db),
) -> MaintenanceRecord:
    # Verify that assest exists in the database, if not raise a 404 error
    if session.get(Asset, payload.asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {payload.asset_id} was not found")
    # Validate the optional alert
    alert = None
    if payload.alert_id is not None:
        alert = session.get(Alert, payload.alert_id)
        if alert is None:
            raise HTTPException(status_code=404, detail=f"Alert {payload.alert_id} was not found")
        if alert.target_asset_id != payload.asset_id:
            raise HTTPException(status_code=422, detail="Alert does not belong to the selected asset")

    data = payload.model_dump()
    data["performed_at"] = data["performed_at"] or utc_now()

    record = MaintenanceRecord(**data)
    session.add(record)
    session.flush() # sends pending changes to db within current transaction.
    emit_event(
        session,
        event_type="maintenance_completed",
        message=f"Maintenance completed: {record.summary} by {record.performed_by}.",
        occurred_at=record.performed_at,
        asset_id=record.asset_id,
        rule_id=alert.rule_id if alert else None,
        alert_id=record.alert_id,
        metadata={
            "maintenance_record_id": record.id,
            "next_due_at": record.next_due_at.isoformat() if record.next_due_at else None,
        },
    )
    session.commit()
    session.refresh(record)
    return record

# listing the maintenance records 
@router.get("")
def list_maintenance_records(
    asset_id: int | None = Query(default=None, gt=0),
    alert_id: int | None = Query(default=None, gt=0),
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    start, end = normalized(start_time), normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
 # Build a list of filters
    conditions = []
    if asset_id is not None:
        conditions.append(MaintenanceRecord.asset_id == asset_id)
    if alert_id is not None:
        conditions.append(MaintenanceRecord.alert_id == alert_id)
    if start is not None:
        conditions.append(MaintenanceRecord.performed_at >= start)
    if end is not None:
        conditions.append(MaintenanceRecord.performed_at <= end)
    # Retrives the acutal maintennace records 
    query = select(MaintenanceRecord)
    count_query = select(func.count()).select_from(MaintenanceRecord)
    for condition in conditions:
        query = query.where(condition)
        count_query = count_query.where(condition)
        # Sort and paginate the results
    rows = session.scalars(
        query.order_by(MaintenanceRecord.performed_at.desc(), MaintenanceRecord.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [MaintenanceRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# Retrieving one maintenance record by its ID
@router.get("/{record_id}", response_model=MaintenanceRead)
def get_maintenance_record(
    record_id: int,
    session: Session = Depends(get_db),
) -> MaintenanceRecord:
    record = session.get(MaintenanceRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Maintenance record {record_id} was not found")
    return record

# Complete Workflow-> Create , Validate , Display history , Open a specific record 