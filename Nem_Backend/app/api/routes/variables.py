
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, Variable
from app.schemas.variable import VariableCreate, VariableRead, VariableUpdate

router = APIRouter(tags=["variables"])


def variable_or_404(session: Session, variable_id: int) -> Variable:
    variable = session.get(Variable, variable_id)
    if variable is None:
        raise HTTPException(
            status_code=404,
            detail=f"Variable {variable_id} was not found",
        )
    return variable


# Create a variable, optionally linked to an OPC UA node.
@router.post(
    "/assets/{asset_id}/variables",
    response_model=VariableRead,
    status_code=status.HTTP_201_CREATED,
)
def create_variable(
    asset_id: int,
    payload: VariableCreate,
    session: Session = Depends(get_db),
) -> Variable:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"Asset {asset_id} was not found",
        )

    variable = Variable(
        asset_id=asset_id,
        **payload.model_dump(),
    )
    session.add(variable)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "Variable key already exists for this asset, "
                "or the OPC UA node is already registered"
            ),
        ) from error

    session.refresh(variable)
    return variable


@router.get("/assets/{asset_id}/variables")
def list_variables(
    asset_id: int,
    is_active: bool | None = None,
    opcua_linked: bool | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"Asset {asset_id} was not found",
        )

    query = select(Variable).where(Variable.asset_id == asset_id)
    count_query = (
        select(func.count())
        .select_from(Variable)
        .where(Variable.asset_id == asset_id)
    )

    if is_active is not None:
        query = query.where(Variable.is_active == is_active)
        count_query = count_query.where(Variable.is_active == is_active)

    if opcua_linked is True:
        query = query.where(Variable.opcua_node_id.is_not(None))
        count_query = count_query.where(Variable.opcua_node_id.is_not(None))
    elif opcua_linked is False:
        query = query.where(Variable.opcua_node_id.is_(None))
        count_query = count_query.where(Variable.opcua_node_id.is_(None))

    rows = session.scalars(
        query.order_by(Variable.id).offset(offset).limit(limit)
    ).all()

    return {
        "items": [VariableRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }


@router.get("/variables/{variable_id}", response_model=VariableRead)
def get_variable(
    variable_id: int,
    session: Session = Depends(get_db),
) -> Variable:
    return variable_or_404(session, variable_id)


@router.patch("/variables/{variable_id}", response_model=VariableRead)
def update_variable(
    variable_id: int,
    payload: VariableUpdate,
    session: Session = Depends(get_db),
) -> Variable:
    variable = variable_or_404(session, variable_id)
    changes = payload.model_dump(exclude_unset=True)

    if not changes:
        raise HTTPException(
            status_code=422,
            detail="Provide at least one field to update",
        )

    for required in ("name", "key", "data_type", "is_active"):
        if required in changes and changes[required] is None:
            raise HTTPException(
                status_code=422,
                detail=f"Variable {required} cannot be null",
            )

    for field, value in changes.items():
        setattr(variable, field, value)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "Variable key already exists for this asset, "
                "or the OPC UA node is already registered"
            ),
        ) from error

    session.refresh(variable)
    return variable
