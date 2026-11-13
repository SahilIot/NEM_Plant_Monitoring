from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.routes import auth, frontend_compat

# Simulates database queries and transaction handling for isolated route tests.
class FakeSession:
    def __init__(self, linked_maintenance_record=False, alert_ids=None):
        self.linked_maintenance_record = linked_maintenance_record
        self.alert_ids = alert_ids or []
        self.scalar_values = [
            SimpleNamespace(id=1),
            SimpleNamespace(id=2),
        ]
        if self.alert_ids:
            self.scalar_values.append(
                SimpleNamespace(id=44) if linked_maintenance_record else None
            )
        self.scalar_values = iter(self.scalar_values)
        self.scalar_rows = iter(
            [
                [
                    SimpleNamespace(id=10, name="Rule A"),
                ],
                [
                    SimpleNamespace(
                        id=20,
                        name="Rule A",
                        source_template_id=10,
                        is_enabled=False,
                    ),
                ],
                self.alert_ids,
            ]
        )
        self.executed = []
        self.committed = False
        self.rolled_back = False

    def scalar(self, statement):
        return next(self.scalar_values)

    def scalars(self, statement):
        return SimpleNamespace(all=lambda: next(self.scalar_rows))

    def execute(self, statement):
        self.executed.append(statement)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

# Ensures only Administrators can unassign rule collections.
@pytest.mark.parametrize("role", ["Supervisor", "Operator"])
def test_non_administrators_cannot_unassign_collection(role):
    # Verify the route dependency blocks direct API requests before database access.
    test_app = FastAPI()
    test_app.include_router(frontend_compat.router)
    test_app.dependency_overrides[auth.get_current_user] = lambda: SimpleNamespace(
        role=role
    )
    test_app.dependency_overrides[frontend_compat.get_db] = lambda: None

    response = TestClient(test_app).delete("/assets/1/rule-collections/2")

    assert response.status_code == 403

# Prevents unassignment while any assigned collection rule is enabled.
def test_unassign_refuses_enabled_collection_rules(monkeypatch):
    # Enabled assigned rules remain intact until an Administrator deactivates them.
    session = FakeSession()
    session.scalar_rows = iter(
        [
            [SimpleNamespace(id=10, name="Rule A")],
            [
                SimpleNamespace(
                    id=20,
                    name="Rule A",
                    source_template_id=10,
                    is_enabled=True,
                )
            ],
        ]
    )
    monkeypatch.setattr(
        frontend_compat,
        "access_scope",
        lambda _session: SimpleNamespace(allows=lambda _asset_id: True),
    )

    with pytest.raises(HTTPException) as error:
        frontend_compat.frontend_unassign_rule_collection(1, 2, session)

    assert error.value.status_code == 409
    assert not session.executed
    assert not session.committed

# Prevents deletion of rules linked to maintenance alerts.
def test_unassign_preserves_rules_with_maintenance_linked_alerts(monkeypatch):
    # Maintenance-linked alerts block unassignment before any related rows are deleted.
    session = FakeSession(linked_maintenance_record=True, alert_ids=[30])
    monkeypatch.setattr(
        frontend_compat,
        "access_scope",
        lambda _session: SimpleNamespace(allows=lambda _asset_id: True),
    )

    with pytest.raises(HTTPException) as error:
        frontend_compat.frontend_unassign_rule_collection(1, 2, session)

    assert error.value.status_code == 409
    assert not session.executed
    assert not session.committed

# Confirms Administrators can safely remove inactive rules and commit the transaction.
def test_administrator_can_safely_unassign_inactive_collection_rules(monkeypatch):
    # Safe unassignment removes only the target asset's inactive rules and commits once.
    session = FakeSession()
    monkeypatch.setattr(
        frontend_compat,
        "access_scope",
        lambda _session: SimpleNamespace(allows=lambda _asset_id: True),
    )
    monkeypatch.setattr(frontend_compat, "emit_event", lambda *_args, **_kwargs: None)

    result = frontend_compat.frontend_unassign_rule_collection(1, 2, session)

    assert result == {"collection_id": 2, "removed": 1, "rule_ids": [20]}
    assert session.executed
    assert session.committed
    assert not session.rolled_back
