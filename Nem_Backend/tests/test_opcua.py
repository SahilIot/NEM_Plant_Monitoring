import asyncio
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.services.opcua_client import (
    OpcUaConfigurationError,
    OpcUaRead,
    _validate_connection_settings,
    read_opcua_node,
)
from tests.test_api import create_asset, create_variable

_SETTINGS_DATABASE_URL = "postgresql+psycopg://localhost/opcua_settings_test"


def test_unconfigured_opcua_endpoints_return_setup_error(client: TestClient):
    client.app.state.settings.opcua_endpoint = ""
    response = client.get("/api/v1/plc/test")
    assert response.status_code == 503
    assert "OPCUA_ENDPOINT" in response.json()["detail"]
    assert client.get("/plc/test").status_code == 503


def test_opcua_read_is_stored_and_triggers_matching_rule(client, monkeypatch):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="rotation_count", data_type="integer")
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Motor service threshold",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">=",
            "threshold": 900,
            "severity": "warning",
        },
    )
    assert rule.status_code == 201, rule.text

    async def fake_read(_settings, node_id):
        assert node_id == "ns=3;s=Motor.RotationCount"
        return OpcUaRead(
            value=900,
            source_timestamp=datetime.now(timezone.utc),
            server_timestamp=None,
        )

    monkeypatch.setattr("app.api.routes.plc.read_opcua_node", fake_read)
    response = client.post(
        "/api/v1/plc/read",
        json={
            "node_id": "ns=3;s=Motor.RotationCount",
            "asset_id": asset_id,
            "variable_id": variable_id,
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["value"] == 900
    assert response.json()["reading"]["source_id"] == "opcua"
    assert response.json()["reading"]["metadata"]["node_id"] == "ns=3;s=Motor.RotationCount"
    active = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()
    assert active["total"] == 1
    assert active["items"][0]["title"] == "Motor service threshold"


def test_opcua_value_must_match_existing_variable_type(client, monkeypatch):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="temperature", data_type="number")

    async def fake_read(_settings, _node_id):
        return OpcUaRead(value="not numeric", source_timestamp=None, server_timestamp=None)

    monkeypatch.setattr("app.api.routes.plc.read_opcua_node", fake_read)
    response = client.post(
        "/api/v1/plc/read",
        json={"node_id": "ns=3;s=Temperature", "asset_id": asset_id, "variable_id": variable_id},
    )
    assert response.status_code == 422
    assert client.get(f"/api/v1/readings/variables/{variable_id}/latest").status_code == 404


def test_opcua_connection_requires_all_pinned_certificate_files(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=_SETTINGS_DATABASE_URL,
        opcua_endpoint="opc.tcp://127.0.0.1:4840",
    )
    with pytest.raises(OpcUaConfigurationError, match="OPCUA_CLIENT_CERT"):
        _validate_connection_settings(settings)

    cert = tmp_path / "client.der"
    key = tmp_path / "client-key.pem"
    for path in (cert, key):
        path.write_bytes(b"placeholder")
    settings = Settings(
        _env_file=None,
        database_url=_SETTINGS_DATABASE_URL,
        opcua_endpoint="opc.tcp://127.0.0.1:4840",
        opcua_client_cert=str(cert),
        opcua_client_key=str(key),
    )
    with pytest.raises(OpcUaConfigurationError, match="OPCUA_SERVER_CERT"):
        _validate_connection_settings(settings)


def test_opcua_rejects_credentials_embedded_in_endpoint_and_partial_auth():
    endpoint_with_credentials = Settings(
        _env_file=None,
        database_url=_SETTINGS_DATABASE_URL,
        opcua_endpoint="opc.tcp://operator:password@127.0.0.1:4840",
    )
    with pytest.raises(OpcUaConfigurationError, match="do not place credentials"):
        _validate_connection_settings(endpoint_with_credentials)

    partial_auth = Settings(
        _env_file=None,
        database_url=_SETTINGS_DATABASE_URL,
        opcua_endpoint="opc.tcp://127.0.0.1:4840",
        opcua_username="operator",
    )
    with pytest.raises(OpcUaConfigurationError, match="Configure both"):
        _validate_connection_settings(partial_auth)


def test_opcua_client_uses_sign_encrypt_and_pinned_server_certificate(tmp_path, monkeypatch):
    paths = {
        key: tmp_path / filename
        for key, filename in (
            ("opcua_client_cert", "client.der"),
            ("opcua_client_key", "client-key.pem"),
            ("opcua_server_cert", "trusted-plc.der"),
        )
    }
    for path in paths.values():
        path.write_bytes(b"placeholder")
    settings = Settings(
        _env_file=None,
        database_url=_SETTINGS_DATABASE_URL,
        opcua_endpoint="opc.tcp://127.0.0.1:4840/machine",
        opcua_client_cert=str(paths["opcua_client_cert"]),
        opcua_client_key=str(paths["opcua_client_key"]),
        opcua_server_cert=str(paths["opcua_server_cert"]),
        opcua_username="operator",
        opcua_password="secret-password",
    )
    captured = {}

    class FakeNode:
        async def read_data_value(self):
            captured["operation"] = "read_data_value"
            return type(
                "DataValue",
                (),
                {
                    "Value": type("Variant", (), {"Value": datetime(2026, 1, 1, tzinfo=timezone.utc)})(),
                    "SourceTimestamp": None,
                    "ServerTimestamp": None,
                },
            )()

    class FakeClient:
        def __init__(self, url, timeout):
            captured["endpoint"] = url
            captured["timeout"] = timeout

        async def set_security_string(self, security):
            captured["security"] = security

        def set_user(self, username):
            captured["username"] = username

        def set_password(self, password):
            captured["password"] = password

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get_node(self, node_id):
            captured["node_id"] = node_id
            return FakeNode()

    monkeypatch.setattr("app.services.opcua_client.Client", FakeClient)
    result = asyncio.run(read_opcua_node(settings, "i=2258"))

    assert result.value == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert "Basic256Sha256,SignAndEncrypt" in captured["security"]
    assert str(paths["opcua_server_cert"]) in captured["security"]
    assert captured["username"] == "operator"
    assert captured["password"] == "secret-password"
    assert captured["operation"] == "read_data_value"
