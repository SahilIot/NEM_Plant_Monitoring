import asyncio

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models import Asset, AuthSession, User, UserAssetAssignment, Variable
from app.services.auth_security import hash_password, hash_session_token


@pytest.fixture
def sqlite_engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()


def test_assigned_asset_scope_covers_reads_bulk_deletes_and_internal_sessions(
    sqlite_engine,
):
    with Session(sqlite_engine) as db:
        assigned = Asset(name="Assigned", asset_type="machine")
        unassigned = Asset(name="Unassigned", asset_type="machine")
        db.add_all([assigned, unassigned])
        db.flush()
        db.add_all(
            [
                Variable(
                    asset_id=assigned.id,
                    name="Run",
                    key="run",
                    data_type="boolean",
                ),
                Variable(
                    asset_id=unassigned.id,
                    name="Run",
                    key="run",
                    data_type="boolean",
                ),
            ]
        )
        db.commit()
        assigned_id, unassigned_id = assigned.id, unassigned.id

    with Session(
        sqlite_engine,
        info={
            "auth_role": "Operator",
            "authorized_asset_ids": frozenset({assigned_id}),
        },
    ) as db:
        assert [asset.id for asset in db.scalars(select(Asset)).all()] == [
            assigned_id
        ]
        unassigned_variable = db.scalar(
            select(Variable).where(Variable.asset_id == unassigned_id)
        )
        assert unassigned_variable is None
        result = db.execute(
            delete(Variable).where(Variable.asset_id == unassigned_id)
        )
        assert result.rowcount == 0
        with pytest.raises(HTTPException) as error:
            db.add(
                Variable(
                    asset_id=unassigned_id,
                    name="Blocked",
                    key="blocked",
                    data_type="boolean",
                )
            )
            db.flush()
        assert error.value.status_code == 403

    with Session(sqlite_engine) as db:
        assert len(db.scalars(select(Asset)).all()) == 2
        assert len(db.scalars(select(Variable)).all()) == 2


def test_http_auth_role_gates_logout_and_admin_user_management(
    monkeypatch, sqlite_engine
):
    import app.main as main
    from app.core.config import get_settings

    monkeypatch.setattr(main, "create_database_engine", lambda _url: sqlite_engine)
    settings = get_settings().model_copy(
        update={
            "monitoring_scheduler_enabled": False,
            "maintenance_due_alerts_enabled": False,
        }
    )
    application = main.create_app(settings)

    with Session(sqlite_engine) as db:
        assigned = Asset(name="Assigned", asset_type="machine")
        unassigned = Asset(name="Unassigned", asset_type="machine")
        admin = User(
            username="admin",
            password_hash=hash_password("correct-admin-password"),
            role="Admin",
            is_active=True,
        )
        operator = User(
            username="operator",
            password_hash=hash_password("correct-operator-password"),
            role="Operator",
            is_active=True,
        )
        db.add_all([assigned, unassigned, admin, operator])
        db.flush()
        db.add(UserAssetAssignment(user_id=operator.id, asset_id=assigned.id))
        db.commit()
        assigned_id = assigned.id

    async def exercise_api():
        async with AsyncClient(
            transport=ASGITransport(app=application),
            base_url="http://test",
        ) as client:
            assert (await client.get("/api/v1/auth/me")).status_code == 401
            operator_login = await client.post(
                "/api/v1/auth/login",
                json={
                    "username": "operator",
                    "password": "correct-operator-password",
                },
            )
            assert operator_login.status_code == 200
            operator_token = operator_login.json()["access_token"]
            operator_headers = {"Authorization": f"Bearer {operator_token}"}

            visible_assets = await client.get(
                "/api/v1/assets", headers=operator_headers
            )
            assert visible_assets.status_code == 200
            assert visible_assets.json()["total"] == 1
            assert visible_assets.json()["items"][0]["id"] == assigned_id
            assert (
                await client.get("/api/v1/auth/users", headers=operator_headers)
            ).status_code == 403
            assert (
                await client.get("/plc/test", headers=operator_headers)
            ).status_code == 403
            assert (
                await client.post(
                    "/api/v1/auth/logout", headers=operator_headers
                )
            ).status_code == 204
            assert (
                await client.get("/api/v1/auth/me", headers=operator_headers)
            ).status_code == 401

            admin_login = await client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "correct-admin-password"},
            )
            assert admin_login.status_code == 200
            admin_headers = {
                "Authorization": f"Bearer {admin_login.json()['access_token']}"
            }
            created = await client.post(
                "/api/v1/auth/users",
                headers=admin_headers,
                json={
                    "username": "viewer",
                    "password": "viewer-password-123",
                    "role": "Viewer",
                    "asset_ids": [],
                },
            )
            assert created.status_code == 201
            viewer_id = created.json()["id"]
            assert (
                await client.patch(
                    f"/api/v1/auth/users/{viewer_id}",
                    headers=admin_headers,
                    json={"is_active": False},
                )
            ).status_code == 200
            assert (
                await client.post(
                    "/api/v1/auth/login",
                    json={
                        "username": "viewer",
                        "password": "viewer-password-123",
                    },
                )
            ).status_code == 401

    try:
        asyncio.run(exercise_api())
    finally:
        main.app.state.engine.dispose()


def test_login_persists_only_a_hash_of_the_session_token(sqlite_engine):
    from app.api.routes.auth import LoginRequest, login

    with Session(sqlite_engine) as db:
        db.add(
            User(
                username="operator",
                password_hash=hash_password("correct-operator-password"),
                role="Operator",
                is_active=True,
            )
        )
        db.commit()
        response = login(
            LoginRequest(
                username="operator",
                password="correct-operator-password",
            ),
            db,
        )
        stored_session = db.scalar(
            select(AuthSession).where(
                AuthSession.token_hash == hash_session_token(response.access_token)
            )
        )
        assert stored_session is not None
        assert stored_session.token_hash != response.access_token
