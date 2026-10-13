from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from tests.test_api import create_asset, create_reading, create_variable


def test_maintenance_records_are_persisted_and_filterable(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Rotation service",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">=",
            "threshold": 900,
            "severity": "warning",
        },
    )
    assert rule.status_code == 201, rule.text
    create_reading(client, asset_id, variable_id, 900)
    alert = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"][0]
    performed_at = datetime.now(timezone.utc)
    next_due_at = performed_at + timedelta(days=180)

    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "alert_id": alert["id"],
            "summary": "Motor lubrication and inspection",
            "notes": "Checked bearing temperature and added lubricant.",
            "performed_by": "Maintenance team",
            "performed_at": performed_at.isoformat(),
            "next_due_at": next_due_at.isoformat(),
        },
    )

    assert created.status_code == 201, created.text
    record = created.json()
    assert record["asset_id"] == asset_id
    assert record["alert_id"] == alert["id"]
    assert record["performed_by"] == "Maintenance team"
    assert client.get(f"/api/v1/maintenance?asset_id={asset_id}").json()["total"] == 1
    assert client.get(f"/api/v1/maintenance?alert_id={alert['id']}").json()["total"] == 1
    assert client.get(f"/api/v1/maintenance/{record['id']}").json()["summary"] == (
        "Motor lubrication and inspection"
    )
    maintenance_events = client.get(
        "/api/v1/events?event_type=maintenance_completed"
    ).json()
    assert maintenance_events["total"] == 1
    assert maintenance_events["items"][0]["metadata"]["maintenance_record_id"] == record["id"]
    assert client.get(f"/api/v1/assets/{asset_id}").status_code == 200
    assert client.delete(f"/api/v1/assets/{asset_id}").status_code == 409


def test_maintenance_rejects_unrelated_alert_and_invalid_dates(client):
    asset_id = create_asset(client)
    other_asset_id = create_asset(client, "Other asset")
    variable_id = create_variable(client, asset_id)
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Threshold",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">",
            "threshold": 1,
            "severity": "alert",
        },
    )
    assert rule.status_code == 201
    create_reading(client, asset_id, variable_id, 2)
    alert = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"][0]

    unrelated = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": other_asset_id,
            "alert_id": alert["id"],
            "summary": "Incorrect association",
            "performed_by": "Operator",
        },
    )
    assert unrelated.status_code == 422

    invalid_dates = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "summary": "Bad date range",
            "performed_by": "Operator",
            "performed_at": "2026-06-01T00:00:00",
            "next_due_at": "2026-05-01T00:00:00",
        },
    )
    assert invalid_dates.status_code == 422


def test_dashboard_serves_ui_and_redirects_root(client):
    root = client.get("/")
    assert root.status_code == 200
    frontend_build = Path(__file__).resolve().parents[2] / "Nem_Frontend" / "dist"
    if not frontend_build.is_dir():
        assert root.url.path == "/docs"
        return
    assert root.url.path == "/ui/"
    page = client.get("/ui/")
    assert page.status_code == 200
    assert "NEM Monitor" in page.text
    script_path = re.search(r'src="([^"]+\.js)"', page.text).group(1)
    script = client.get(script_path)
    assert script.status_code == 200
    assert "assets" in script.text
    assert client.get("/ui/plc").status_code == 200
