from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Alert, Asset, MonitoringRule, Reading, RuleState, Variable
from app.schemas.dashboard import DashboardSummary


router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(session: Session = Depends(get_db)) -> DashboardSummary:
    total = session.scalar(select(func.count()).select_from(Asset)) or 0
    active = session.scalar(
        select(func.count()).select_from(Asset).where(Asset.is_active.is_(True))
    ) or 0
    rule_total = session.scalar(select(func.count()).select_from(MonitoringRule)) or 0
    enabled = session.scalar(
        select(func.count()).select_from(MonitoringRule).where(MonitoringRule.is_enabled.is_(True))
    ) or 0
    disabled = rule_total - enabled
    monitored = session.scalar(
        select(func.count(func.distinct(Variable.asset_id)))
        .join(Asset, Asset.id == Variable.asset_id)
        .where(Variable.is_active.is_(True), Asset.is_active.is_(True))
    ) or 0
    latest = session.scalar(select(func.max(Reading.recorded_at)))
    state_counts = {
        status: session.scalar(
            select(func.count())
            .select_from(RuleState)
            .join(MonitoringRule, MonitoringRule.id == RuleState.rule_id)
            .where(MonitoringRule.is_enabled.is_(True), RuleState.status == status)
        ) or 0
        for status in ("normal", "warning", "alert", "unknown")
    }
    evaluated_statuses = sum(state_counts.values())
    state_counts["unknown"] += max(0, enabled - evaluated_statuses)
    asset_alert_count = session.scalar(
        select(func.count(func.distinct(Alert.target_asset_id))).where(
            Alert.status == "active", Alert.severity == "alert"
        )
    ) or 0
    asset_warning_count = session.scalar(
        select(func.count(func.distinct(Alert.target_asset_id))).where(
            Alert.status == "active", Alert.severity == "warning"
        )
    ) or 0
    active_alert_count = session.scalar(
        select(func.count()).select_from(Alert).where(Alert.status == "active")
    ) or 0
    unacknowledged_count = session.scalar(
        select(func.count()).select_from(Alert).where(
            Alert.status == "active", Alert.acknowledged_at.is_(None)
        )
    ) or 0
    return DashboardSummary(
        total_assets=total,
        active_assets=active,
        inactive_assets=total - active,
        monitored_assets=monitored,
        assets_in_alert_state=asset_alert_count,
        assets_in_warning_state=asset_warning_count,
        alert_counts_available=True,
        total_rules=rule_total,
        enabled_rules=enabled,
        disabled_rules=disabled,
        rules_normal=state_counts["normal"],
        rules_warning=state_counts["warning"],
        rules_alert=state_counts["alert"],
        rules_unknown=state_counts["unknown"],
        total_active_alerts=active_alert_count,
        unacknowledged_active_alerts=unacknowledged_count,
        latest_reading_at=latest,
    )
