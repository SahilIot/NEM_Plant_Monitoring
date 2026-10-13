from datetime import datetime, timezone
import math

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError #Catched Pydantic validation failures
from sqlalchemy.orm import Session # Represents the SQLAlchemy database session

# connect this router to your application`s own modules
from app.db.session import get_db
from app.schemas.opcua import OpcUaReadRequest, OpcUaReadResponse # Request and Response 
from app.schemas.reading import ReadingCreate, ReadingRead # reading before ingestion and how reading is represented in API response

from app.services.opcua_client import (
    OpcUaConfigurationError,
    OpcUaConnectionError,
    read_opcua_node, 
    test_opcua_connection,
)
from app.services.reading_ingestion import ingest_reading

router = APIRouter(prefix="/plc", tags=["PLC / OPC UA"])

#Translate internal errors into HTTP errors
def opcua_http_error(error: Exception) -> HTTPException:
    if isinstance(error, OpcUaConfigurationError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))

#Test the PLC connection
@router.get("/test")
async def plc_connection_test(request: Request) -> dict[str, object]:
    try:
        return await test_opcua_connection(request.app.state.settings)
    except (OpcUaConfigurationError, OpcUaConnectionError) as error:
        raise opcua_http_error(error) from error

# main endpoint 
@router.post("/read", response_model=OpcUaReadResponse, status_code=201)
async def read_plc_value(
    payload: OpcUaReadRequest,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, object]:
    #Read the requested PLC node
    try:
        plc_value = await read_opcua_node(request.app.state.settings, payload.node_id)
    except (OpcUaConfigurationError, OpcUaConnectionError) as error:
        raise opcua_http_error(error) from error

# Reject non-finite floating point-values

    value = plc_value.value
    if isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(status_code=422, detail="OPC UA returned a non-finite numeric value")
    recorded_at = plc_value.source_timestamp or plc_value.server_timestamp or datetime.now(timezone.utc)
    # Validate the reading using ReadingCreate
    try:
        reading_payload = ReadingCreate(
            asset_id=payload.asset_id,
            variable_id=payload.variable_id,
            value=value,
            recorded_at=recorded_at,
            source_id=payload.source_id or "opcua",
            metadata={
                "protocol": "opc.tcp",
                "node_id": payload.node_id,
                "source_timestamp": (
                    plc_value.source_timestamp.isoformat() if plc_value.source_timestamp else None
                ),
                "server_timestamp": (
                    plc_value.server_timestamp.isoformat() if plc_value.server_timestamp else None
                ),
            },
        )
    except ValidationError as error:
        raise HTTPException(
            status_code=422,
            detail="OPC UA value cannot be represented by the selected variable's supported data type.",
        ) from error

# Pass the reading to the ingestion service
    reading = ingest_reading(
        session,
        reading_payload,
        stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
    )
    return {
        "node_id": payload.node_id,
        "value": reading.value,
        "reading": ReadingRead.model_validate(reading),
    }

async def plc_connection_test_compat(request: Request) -> dict[str, object]:
    return await plc_connection_test(request)

# this file expose HTTP endpoints so that client can request a plc connection test 

# Validate OPC UA status quality
# Verify the node-to-varibale mapping
# Understand transaction handling
# Separate polling from the HTTP request
# Review the HTTP response code
