# Payload keys
KIND = "kind"
SCHEDULE = "schedule"
AGGREGATION = "aggregation"
INTERVAL_PARAMETER = "interval_parameter"
ACTIVATION_AT = "activation_at"
LIFECYCLE_STATUS = "lifecycle_status"
RULE_TYPE = "rule_type"

#  Parameter kinds
INTERVAL = "interval"
NUMBER = "number"
BOOLEAN = "boolean"

#  Aggregations, interval parameters, schedule modes and live modes 
TIMER = "timer"
COUNTER = "counter"
USAGE = "usage"
TIME = "time"
CALENDAR = "calendar"
RUNTIME = "runtime"

# Signal roles 
CYCLE = "cycle"
RUNNING = "running"

#  Rule types 
RULE_MULTI_PARAMETER = "multi_parameter"
RULE_RUNTIME_DURATION = "runtime_duration"
RULE_PARAMETER_THRESHOLD = "parameter_threshold"
RULE_BOOLEAN_COUNT_THRESHOLD = "boolean_count_threshold"

#  Statuses (maintenance records and schedules, rule lifecycle, parameter results, alerts) 
STATUS_PLANNED = "planned"
STATUS_PENDING = "pending"
STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"
STATUS_CANCELLED = "cancelled"
STATUS_RESOLVED = "resolved"
STATUS_ACTIVE = "active"
STATUS_DEACTIVATED = "deactivated"
STATUS_SUSPENDED = "suspended"
STATUS_UNKNOWN = "unknown"
STATUS_NORMAL = "normal"
STATUS_WARNING = "warning"
STATUS_ALERT = "alert"

PROGRESS_RESET = "reset"
PROGRESS_RETAINED = "retained"

# Rule categories (the "category" of a multi_parameter rule; "parameter_threshold" is RULE_PARAMETER_THRESHOLD)
CATEGORY_INTERVAL_BASED = "interval_based"

# More rule types
RULE_GENERIC = "generic"
RULE_DURATION = "duration"
RULE_BOOLEAN_CONDITION = "boolean_condition"

# More aggregations
AGGREGATION_NONE = "none"
AGGREGATION_LAST = "last"

# Maintenance schedule mode created by monitoring rules, schedule statuses, approval states and rule eligibility
SCHEDULE_MODE_RULE = "rule"
STATUS_PAUSED = "paused"
STATUS_AWAITING_APPROVAL = "awaiting_approval"
APPROVAL_NOT_REQUIRED = "not_required"
APPROVAL_APPROVED = "approved"
APPROVAL_DECLINED = "declined"
ELIGIBILITY_NOT_DUE = "not_due"
ELIGIBILITY_READY = "ready"

# Email notification delivery states ("pending" is STATUS_PENDING)
NOTIFICATION_SENT = "sent"
NOTIFICATION_FAILED = "failed"
NOTIFICATION_SKIPPED = "skipped"

# User roles
ROLE_ADMINISTRATOR = "Administrator"
ROLE_SUPERVISOR = "Supervisor"
ROLE_OPERATOR = "Operator"

# Event types used in more than one place
EVENT_RULE_CREATED = "rule_created"
EVENT_ALERT_RESOLVED = "alert_resolved"
EVENT_ALERT_COMPLETED = "alert_completed"
EVENT_ALERT_SEVERITY_CHANGED = "alert_severity_changed"
EVENT_WARNING_TRIGGERED = "warning_triggered"
EVENT_STALE_DATA_DETECTED = "stale_data_detected"
EVENT_RULE_PERMANENTLY_DELETED = "rule_permanently_deleted"
EVENT_MAINTENANCE_COMPLETED = "maintenance_completed"
EVENT_MAINTENANCE_RECORD_PERMANENTLY_DELETED = "maintenance_record_permanently_deleted"

# Error messages returned in several places
ERR_NO_FIELDS_TO_UPDATE = "Provide at least one field to update"
ERR_START_AFTER_END = "start_time must not be later than end_time"
ERR_TEMPLATE_NOT_FOUND = "Rule template was not found"
ERR_DOCUMENT_ATTACHMENT_NOT_FOUND = "Document attachment was not found"
ERR_SUPERVISOR_PARAMETER_EDIT = "Supervisors may only change the Due and Overdue values of a parameter"
ERR_ASSET_HIERARCHY_CYCLE = "Existing asset hierarchy contains a cycle"
