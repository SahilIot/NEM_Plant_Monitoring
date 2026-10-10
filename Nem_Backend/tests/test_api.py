from datetime import datetime, timedelta, timezone


def create_asset(client, name="Asset A", parent_id=None, asset_type="machine"):
    response = client.post(
        "/api/v1/assets",
        json={
            "name": name,
            "asset_type": asset_type,
            "parent_asset_id": parent_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_variable(client, asset_id, key="temperature", data_type="number"):
    response = client.post(
        f"/api/v1/assets/{asset_id}/variables",
        json={"name": key.title(), "key": key, "data_type": data_type, "unit": "C"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_reading(client, asset_id, variable_id, value=42.5, recorded_at=None):
    payload = {
        "asset_id": asset_id,
        "variable_id": variable_id,
        "value": value,
        "source_id": "test-source",
        "metadata": {"origin": "automated-test"},
    }
    if recorded_at is not None:
        payload["recorded_at"] = recorded_at.isoformat()
    return client.post("/api/v1/readings", json=payload)


def test_health_and_readiness(client):
    assert client.get("/api/v1/health").json() == {"status": "ok"}
    ready = client.get("/api/v1/ready")
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready", "database": "connected"}


def test_asset_crud_hierarchy_children_pagination_and_filtering(client):
    root = create_asset(client, "Root")
    child = create_asset(client, "Child", root)
    grandchild = create_asset(client, "Grandchild", child)

    assert client.get(f"/api/v1/assets/{child}").json()["parent_asset_id"] == root
    assert client.patch(f"/api/v1/assets/{child}", json={"name": "Updated Child"}).json()[
        "name"
    ] == "Updated Child"
    children = client.get(f"/api/v1/assets/{root}/children").json()
    assert [row["id"] for row in children["items"]] == [child]
    tree = client.get(f"/api/v1/assets/{grandchild}/hierarchy").json()
    assert tree["id"] == root
    assert tree["children"][0]["children"][0]["id"] == grandchild

    page = client.get("/api/v1/assets?root_only=true&limit=1").json()
    assert page["total"] == 1
    assert page["items"][0]["id"] == root
    assert client.get("/api/v1/assets?asset_type=machine").json()["total"] == 3
    assert client.get("/api/v1/assets?limit=0").status_code == 422


def test_asset_move_validates_parents_and_blocks_cycles(client):
    root_a = create_asset(client, "Root A")
    root_b = create_asset(client, "Root B")
    child = create_asset(client, "Child", root_a)
    grandchild = create_asset(client, "Grandchild", child)

    moved = client.post(f"/api/v1/assets/{child}/move", params={"parent_asset_id": root_b})
    assert moved.status_code == 200
    assert moved.json()["parent_asset_id"] == root_b
    assert client.post(
        f"/api/v1/assets/{root_b}/move", params={"parent_asset_id": grandchild}
    ).status_code == 409
    assert client.post(
        f"/api/v1/assets/{child}/move", params={"parent_asset_id": 999}
    ).status_code == 404
    assert client.patch(
        f"/api/v1/assets/{root_a}", json={"parent_asset_id": root_a}
    ).status_code == 409
    assert client.patch(f"/api/v1/assets/{child}", json={"parent_asset_id": None}).status_code == 200


def test_asset_deactivation_preserves_history_and_delete_rejects_dependents(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    create_reading(client, asset_id, variable_id)
    assert client.patch(f"/api/v1/assets/{asset_id}", json={"is_active": False}).status_code == 200
    assert client.get(f"/api/v1/readings/variables/{variable_id}/latest").status_code == 200
    deleted = client.delete(f"/api/v1/assets/{asset_id}")
    assert deleted.status_code == 409
    assert deleted.json()["error"]["code"] == 409
    assert client.get(f"/api/v1/assets/{asset_id}").status_code == 200
    empty = create_asset(client, "Empty")
    assert client.delete(f"/api/v1/assets/{empty}").status_code == 204


def test_variables_validate_assets_unique_keys_types_and_deactivation(client):
    asset = create_asset(client)
    variable_id = create_variable(client, asset)
    assert client.post(
        f"/api/v1/assets/{asset}/variables",
        json={"name": "Temperature duplicate", "key": "temperature", "data_type": "number"},
    ).status_code == 409
    assert client.post(
        "/api/v1/assets/999/variables",
        json={"name": "Invalid", "key": "invalid", "data_type": "string"},
    ).status_code == 404
    assert client.patch(
        f"/api/v1/variables/{variable_id}", json={"name": "Motor temperature"}
    ).json()["name"] == "Motor temperature"
    assert client.get(f"/api/v1/assets/{asset}/variables?is_active=true").json()["total"] == 1
    assert client.patch(
        f"/api/v1/variables/{variable_id}", json={"is_active": False}
    ).json()["is_active"] is False
    assert client.post(
        f"/api/v1/assets/{asset}/variables",
        json={"name": "Bad type", "key": "bad", "data_type": "blob"},
    ).status_code == 422


def test_readings_type_relationship_batch_atomicity_latest_history_and_pagination(client):
    asset = create_asset(client)
    numeric_variable = create_variable(client, asset)
    other_asset = create_asset(client, "Other")
    other_variable = create_variable(client, other_asset, "state", "string")
    assert create_reading(client, asset, numeric_variable, "42").status_code == 422
    assert create_reading(client, asset, other_variable, "running").status_code == 422

    start = datetime.now(timezone.utc) - timedelta(minutes=10)
    first = create_reading(client, asset, numeric_variable, 12.5, start)
    assert first.status_code == 201, first.text
    assert first.json()["metadata"] == {"origin": "automated-test"}
    later = create_reading(client, asset, numeric_variable, 15, start + timedelta(minutes=5))
    assert later.status_code == 201
    history_url = f"/api/v1/readings/variables/{numeric_variable}"
    history = client.get(f"{history_url}?limit=1").json()
    assert history["total"] == 2
    assert history["items"][0]["value"] == 15
    latest = client.get(f"/api/v1/readings/variables/{numeric_variable}/latest")
    assert latest.json()["value"] == 15
    asset_latest = client.get(f"/api/v1/readings/assets/{asset}/latest")
    assert len(asset_latest.json()) == 1
    assert client.get(
        f"{history_url}?start_time={(start + timedelta(days=1)).isoformat()}&end_time={start.isoformat()}"
    ).status_code == 422

    batch_url = "/api/v1/readings/batch"
    before = history["total"]
    invalid_batch = client.post(
        batch_url,
        json={
            "readings": [
                {"asset_id": asset, "variable_id": numeric_variable, "value": 20},
                {"asset_id": asset, "variable_id": other_variable, "value": "bad"},
            ]
        },
    )
    assert invalid_batch.status_code == 422
    assert client.get(history_url).json()["total"] == before
    batch = client.post(
        batch_url,
        json={
            "readings": [
                {"asset_id": asset, "variable_id": numeric_variable, "value": 20},
                {"asset_id": asset, "variable_id": numeric_variable, "value": 21},
            ]
        },
    )
    assert batch.status_code == 201, batch.text
    assert len(batch.json()) == 2
    assert client.post(
        batch_url, json={"readings": [{}] * 101}
    ).status_code == 422


def test_typed_string_boolean_integer_readings_and_metadata(client):
    asset = create_asset(client)
    state = create_variable(client, asset, "state", "string")
    enabled = create_variable(client, asset, "enabled", "boolean")
    count = create_variable(client, asset, "count", "integer")
    assert create_reading(client, asset, state, "running").status_code == 201
    assert create_reading(client, asset, enabled, True).status_code == 201
    assert create_reading(client, asset, count, 4).status_code == 201
    assert create_reading(client, asset, count, 4.5).status_code == 422


def test_rule_definitions_validation_crud_filters_and_not_evaluated(client):
    asset = create_asset(client)
    variable = create_variable(client, asset)
    payload = {
        "name": "Temperature warning",
        "rule_type": "parameter_threshold",
        "target_asset_id": asset,
        "variable_id": variable,
        "operator": "gte",
        "threshold": 80,
        "severity": "warning",
        "evaluation_interval_seconds": 60,
    }
    created = client.post("/api/v1/rules", json=payload)
    assert created.status_code == 201, created.text
    rule_id = created.json()["id"]
    assert client.get(f"/api/v1/rules/{rule_id}").status_code == 200
    filtered = client.get(
        f"/api/v1/rules?target_asset_id={asset}&severity=warning&is_enabled=true"
    ).json()
    assert filtered["total"] == 1
    updated = client.patch(f"/api/v1/rules/{rule_id}", json={"is_enabled": False})
    assert updated.status_code == 200
    assert updated.json()["is_enabled"] is False
    assert client.post(
        "/api/v1/rules",
        json={**payload, "name": "Bad reference", "target_asset_id": 999},
    ).status_code == 404
    assert client.post(
        "/api/v1/rules",
        json={**payload, "name": "Wrong variable", "target_asset_id": create_asset(client, "Other")},
    ).status_code == 422
    assert client.post(
        "/api/v1/rules",
        json={"name": "Bad operator", "rule_type": "parameter_threshold",
              "variable_id": variable, "operator": "near", "threshold": 2,
              "severity": "alert"},
    ).status_code == 422
    runtime = client.post(
        "/api/v1/rules",
        json={"name": "Runtime rule", "rule_type": "runtime_duration",
              "target_asset_id": asset, "parameters": {"duration_seconds": 3600},
              "severity": "alert"},
    )
    assert runtime.status_code == 201


def test_dashboard_counts_actual_records_and_marks_alert_counts_unavailable(client):
    empty = client.get("/api/v1/dashboard/summary").json()
    assert empty["total_assets"] == empty["total_rules"] == 0
    assert empty["latest_reading_at"] is None
    assert empty["alert_counts_available"] is True
    assert empty["assets_in_alert_state"] == empty["assets_in_warning_state"] == 0

    asset = create_asset(client)
    inactive = create_asset(client, "Inactive")
    client.patch(f"/api/v1/assets/{inactive}", json={"is_active": False})
    variable = create_variable(client, asset)
    create_reading(client, asset, variable)
    client.post(
        "/api/v1/rules",
        json={"name": "Generic", "rule_type": "generic", "target_asset_id": asset,
              "severity": "warning"},
    )
    summary = client.get("/api/v1/dashboard/summary").json()
    assert (summary["total_assets"], summary["active_assets"], summary["inactive_assets"]) == (
        2, 1, 1
    )
    assert summary["monitored_assets"] == 1
    assert (summary["total_rules"], summary["enabled_rules"], summary["disabled_rules"]) == (
        1, 1, 0
    )
    assert summary["latest_reading_at"] is not None


def test_consistent_validation_errors_and_request_size_limit(client):
    response = client.post("/api/v1/assets", json={"name": "", "asset_type": "machine"})
    assert response.status_code == 422
    assert response.json()["error"]["message"] == "Request validation failed"
    too_large = client.post(
        "/api/v1/assets",
        content=b" " * (1_048_577),
        headers={"Content-Type": "application/json"},
    )
    assert too_large.status_code == 413
