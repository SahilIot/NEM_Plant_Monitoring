# Model registration/import file. purpose is to make sure the application`s db models are imported and registered with the ORM.
from app.models.asset import Asset
from app.models.auth import AuthSession, User
from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.machine_monitoring import MachineMonitoringState, RuleCounterState
from app.models.frontend_data import (
    BackupRecord,
    FrontendConfig,
    InstructionDocument,
    InstructionDocumentFile,
    RuleCollection,
)
from app.models.notification import AssetSupervisor, EmailNotification
from app.models.labels import Label
from app.models.reading import Reading
from app.models.rule import (
    Alert,
    MonitoringEvent,
    MonitoringRule,
    MonitoringRuleTemplate,
    MonitoringRuleTemplateRequest,
    RuleState,
    SchedulerLease,
)
from app.models.variable import Variable
from app.models.rule_visibility import RuleTemplateChange, RuleVisibilityChange
from app.models.config_import import ConfigurationImport
from app.models import audit as _audit  # noqa: F401  (registers audit stamping)

__all__ = [
    "User", "AuthSession",
    "Asset", "Variable", "Reading", "MonitoringRule", "MonitoringRuleTemplate", "RuleState", "MaintenanceRecord",
    "MaintenanceSchedule",
    "Alert", "MonitoringEvent", "SchedulerLease",
    "MachineMonitoringState",
    "RuleCounterState",
    "AssetSupervisor", "EmailNotification",
    "Label",
    "ConfigurationImport",
    "FrontendConfig", "RuleCollection", "InstructionDocument", "BackupRecord", "InstructionDocumentFile",
]
