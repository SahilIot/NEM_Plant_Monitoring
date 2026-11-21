# Current evaluation state of a monitoring rule, read from the stored rule state (shared by the monitoring and rules routes).
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import STATUS_UNKNOWN
from app.models import MonitoringRule, RuleState, Variable
from app.schemas.monitoring import RuleStateRead

#  state_for_rule -> Retrieves the current state of a given monitoring rule. It checks if the rule is associated with an asset or variable, fetches the corresponding RuleState from the database, and returns it in a structured format. If no state is found, it returns a default "unknown" state indicating that the rule has not yet been evaluated.
# reads the stored state
def state_for_rule(session: Session, rule: MonitoringRule) -> RuleStateRead:
    asset_id = rule.target_asset_id
    if asset_id is None and rule.variable_id is not None:
        variable = session.get(Variable, rule.variable_id)
        asset_id = variable.asset_id if variable else None
    state = session.scalar(
        select(RuleState).where(
            RuleState.rule_id == rule.id,
            RuleState.target_asset_id == asset_id,
        )
    ) if asset_id is not None else None
    if state is None:
        return RuleStateRead(
            rule_id=rule.id,
            target_asset_id=asset_id,
            target_variable_id=rule.variable_id,
            status=STATUS_UNKNOWN,
            message="Rule has not yet been evaluated.",
        )
    return RuleStateRead.model_validate(state)
