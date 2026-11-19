"""Shared string constants for rules, parameters, schedules and maintenance.

The values are the exact strings stored in the database and exchanged with the frontend, so they must never be
changed here without a migration. Use these names instead of repeating the literals.

Models, schemas (``Literal[...]`` types), SQL text and migrations keep their literal strings on purpose: they
describe the stored format itself.
"""

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
