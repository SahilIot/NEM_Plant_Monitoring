#Readings API router.Focusing on receiving PLC readings,saving them to postgreSQL,retrieving the lastest or historical readings for the frontend
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, Reading, Variable
from app.schemas.reading import ReadingBatch, ReadingCreate, ReadingRead
from app.services.monitoring_engine import evaluate_reading_rules
from app.services.reading_ingestion import (ingest_reading as persist_reading,make_reading,validate_reading,)

router = APIRouter(prefix="/readings", tags=["readings"])
MAX_BATCH_SIZE = 100

@router.post("", response_model=ReadingRead, status_code=status.HTTP_201_CREATED)
def ingest_reading(payload: ReadingCreate, request: Request, session: Session = Depends(get_db)) -> Reading:
    return persist_reading(session,payload,
        stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
    )

@router.get("/latest", response_model=list[ReadingRead])
def latest_readings(
    limit: int = Query(default=100, ge=1, le=1000),
    session: Session = Depends(get_db),
) -> list[ReadingRead]:
    """Return the newest reading for each asset-variable pair."""
    rows = session.scalars(
        select(Reading).order_by(
            Reading.recorded_at.desc(),
            Reading.id.desc(),
        )
    ).all()

    latest: dict[tuple[int, int], Reading] = {}

    for row in rows:
        key = (row.asset_id, row.variable_id)
        if key not in latest:
            latest[key] = row

        if len(latest) >= limit:
            break

    return [ReadingRead.model_validate(row) for row in latest.values()]


@router.post("/batch", response_model=list[ReadingRead], status_code=status.HTTP_201_CREATED)
def ingest_batch(
    payload: ReadingBatch, request: Request, session: Session = Depends(get_db)
) -> list[Reading]:
    if len(payload.readings) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=422, detail=f"Batch size cannot exceed {MAX_BATCH_SIZE} readings"
        )
    for item in payload.readings:
        validate_reading(session, item)
    readings = [make_reading(item) for item in payload.readings]
    session.add_all(readings)
    session.flush()
    for asset_id, variable_id in {
        (reading.asset_id, reading.variable_id) for reading in readings
    }:
        evaluate_reading_rules(
            session,
            asset_id=asset_id,
            variable_id=variable_id,
            stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
        )
    session.commit()
    for reading in readings:
        session.refresh(reading)
    return readings


@router.get("/assets/{asset_id}/latest")
def latest_asset_readings(
    asset_id: int,
    session: Session = Depends(get_db),
) -> list[ReadingRead]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    rows = session.scalars(
        select(Reading)
        .where(Reading.asset_id == asset_id)
        .order_by(Reading.recorded_at.desc(), Reading.id.desc())
    )
    latest: dict[int, Reading] = {}
    for row in rows:
        latest.setdefault(row.variable_id, row)
    return [ReadingRead.model_validate(row) for row in latest.values()]


@router.get("/variables/{variable_id}/latest", response_model=ReadingRead)
def latest_variable_reading(
    variable_id: int, session: Session = Depends(get_db)
) -> Reading:
    if session.get(Variable, variable_id) is None:
        raise HTTPException(status_code=404, detail=f"Variable {variable_id} was not found")
    reading = session.scalar(
        select(Reading)
        .where(Reading.variable_id == variable_id)
        .order_by(Reading.recorded_at.desc(), Reading.id.desc())
        .limit(1)
    )
    if reading is None:
        raise HTTPException(status_code=404, detail="No readings exist for this variable")
    return reading


@router.get("/variables/{variable_id}")
def list_variable_readings(
    variable_id: int,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    if session.get(Variable, variable_id) is None:
        raise HTTPException(status_code=404, detail=f"Variable {variable_id} was not found")

    def normalize(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    start, end = normalize(start_time), normalize(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
    query = select(Reading).where(Reading.variable_id == variable_id)
    count_query = select(func.count()).select_from(Reading).where(Reading.variable_id == variable_id)
    if start is not None:
        query, count_query = query.where(Reading.recorded_at >= start), count_query.where(
            Reading.recorded_at >= start
        )
    if end is not None:
        query, count_query = query.where(Reading.recorded_at <= end), count_query.where(
            Reading.recorded_at <= end
        )
    rows = session.scalars(
        query.order_by(Reading.recorded_at.desc(), Reading.id.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [ReadingRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }
