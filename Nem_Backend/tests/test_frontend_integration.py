from cryptography.fernet import Fernet
from pydantic import SecretStr

from app.models import FrontendConfig


def create_asset(client, name="Machine 1"):
    response = client.post(
        "/api/v1/assets", json={"name": name, "asset_type": "machine"}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_numeric_variable(client, asset_id):
    response = client.post(
        f"/api/v1/assets/{asset_id}/variables",
        json={
            "name": "Rotation count",
            "key": "rotation_count",
            "data_type": "integer",
            "unit": "cycles",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_frontend_compatibility_maps_rules_and_maintenance(client):
    asset_id = create_asset(client)
    variable_id = create_numeric_variable(client, asset_id)
    created = client.post(
        f"/api/v1/assets/{asset_id}/rules",
        json={
            "name": "Motor cycle warning",
            "description": "Warn before maintenance",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "rule_type": "parameter_threshold",
            "operator": ">=",
            "threshold": 900,
            "severity": "warning",
        },
    )
    assert created.status_code == 201, created.text
    rule_id = created.json()["id"]
    assert created.json()["state"] == "activated"

    ingested = client.post(
        "/api/v1/readings",
        json={"asset_id": asset_id, "variable_id": variable_id, "value": 900},
    )
    assert ingested.status_code == 201, ingested.text
    assert client.get(f"/api/v1/assets/{asset_id}/rules").json()[0]["status"] == "warning"

    log = client.post(
        f"/api/v1/assets/{asset_id}/logbook", json={"text": "Inspected motor"}
    )
    assert log.status_code == 201, log.text
    assert client.get(f"/api/v1/assets/{asset_id}/logbook").json()[0]["text"] == "Inspected motor"

    status_rows = client.get("/api/v1/rules/status/warning")
    assert status_rows.status_code == 200
    assert status_rows.json()[0]["id"] == rule_id
    assert status_rows.json()[0]["asset_name"] == "Machine 1"
    assert client.get("/api/v1/summary").json()["rules_warning"] == 1

    changed = client.patch(f"/api/v1/rules/{rule_id}", json={"is_enabled": False})
    assert changed.status_code == 200, changed.text
    assert changed.json()["is_enabled"] is False
    assert client.get(f"/api/v1/assets/{asset_id}/rules").json()[0]["state"] == "not_activated"


def test_frontend_profile_collections_and_documents(client):
    saved_profile = client.put(
        "/api/v1/me",
        json={"name": "Plant Manager", "email": "manager@example.com", "phone": "123"},
    )
    assert saved_profile.status_code == 200
    assert saved_profile.json()["name"] == "Plant Manager"
    assert saved_profile.json()["role"] == "Administrator"

    collection = client.post(
        "/api/v1/collections",
        json={"name": "Motor rules", "description": "Motor monitoring rules"},
    )
    assert collection.status_code == 201, collection.text
    assert client.get("/api/v1/collections").json()[0]["name"] == "Motor rules"

    document = client.post(
        "/api/v1/documents",
        json={"title": "Motor checklist", "kind": "Checklist", "description": "Inspect bearings"},
    )
    assert document.status_code == 201, document.text
    assert client.get("/api/v1/documents").json()[0]["title"] == "Motor checklist"


def test_frontend_email_settings_encrypt_password_and_preserve_it(client):
    encryption_key = Fernet.generate_key()
    client.app.state.settings.settings_encryption_key = SecretStr(encryption_key.decode())

    saved = client.put(
        "/api/v1/settings/email",
        json={
            "host": "smtp.example.com",
            "port": "587",
            "username": "machine-monitor",
            "password": "example-secret",
            "sender": "monitor@example.com",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["password"] == ""
    assert saved.json()["has_password"] is True
    assert "example-secret" not in saved.text

    with client.app.state.session_factory() as session:
        ciphertext = session.get(FrontendConfig, "email").value["password_ciphertext"]
    assert Fernet(encryption_key).decrypt(ciphertext.encode()).decode() == "example-secret"

    loaded = client.get("/api/v1/settings/email")
    assert loaded.status_code == 200
    assert loaded.json()["password"] == ""
    assert "password_ciphertext" not in loaded.json()

    preserved = client.put("/api/v1/settings/email", json=loaded.json())
    assert preserved.status_code == 200
    assert preserved.json()["has_password"] is True


def test_frontend_backup_restore_replaces_monitoring_data(client, tmp_path):
    client.app.state.settings.backup_directory = str(tmp_path / "backups")
    asset_id = create_asset(client)
    variable_id = create_numeric_variable(client, asset_id)
    backup = client.post("/api/v1/backups", json={"name": "Before change"})
    assert backup.status_code == 201, backup.text

    updated = client.patch(
        f"/api/v1/assets/{asset_id}", json={"name": "Changed machine"}
    )
    assert updated.status_code == 200
    restored = client.post(f"/api/v1/backups/{backup.json()['id']}/restore")
    assert restored.status_code == 200, restored.text

    assets = client.get("/api/v1/assets?limit=200").json()["items"]
    assert [asset["name"] for asset in assets] == ["Machine 1"]
    assert assets[0]["id"] == asset_id
    variables = client.get(f"/api/v1/assets/{asset_id}/variables?limit=200").json()["items"]
    assert variables[0]["id"] == variable_id
