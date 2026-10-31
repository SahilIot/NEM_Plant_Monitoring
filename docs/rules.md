# Business rules

## Asset, variable, and reading rules

- An asset may have a parent asset and children. Self-parenting and cyclic moves
  are rejected.
- Every variable belongs to exactly one asset. Variable keys are unique within
  that asset. Supported types are `number`, `integer`, `string`, and `boolean`.
- Optional variable `signal_role` values are `cycle` and `running`; a signal
  role is valid only for a Boolean variable.
- A reading must reference an existing active asset and active variable, and
  that variable must belong to the supplied asset. The value must match the
  declared type; booleans are not accepted as numbers, and numeric values must
  be finite. A supplied reading timestamp more than five minutes in the
  future is rejected.
- Single readings and atomic batches enter through `services/reading_ingestion.py`.
  Accepted readings can update signal states and evaluate matching rules.

## OPC UA mapping and signal freshness

Mapping is configured in backend `OPCUA_MACHINE_MAPPINGS`; it is not generated
by the frontend. Each configured asset occurs at most once in the mapping.
NodeIds may be shared between assets but cannot be repeated within one asset's
entry. A mapping must reference an active variable owned by the configured
asset; cycle and running signals must be Boolean.

The optional `OPC_UA_MAPPING_BYPASS_ENABLED` testing mode additionally uses
eligible active asset-owned variable declarations with valid NodeIds. An
explicit configured role takes precedence. Boolean variables need the
corresponding `Cycle signal` or `Machine running state` purpose to be offered
for those rule types; the current schema values are `cycle` and `running`.

OPC UA source/server timestamps are normalized to UTC. Missing timestamps use
receipt time; naive timestamps are logged and interpreted as UTC. The
out-of-order guard rejects cycle/running samples older than the last accepted
signal timestamp. `MONITORING_DEFAULT_STALE_AFTER_SECONDS` defaults to 300
seconds; a rule may override its stale window. Bad-quality, missing, stale,
ill-typed, or untrusted values do not refresh trustworthy running state.

### Cycle count

- Machine cycle count increments only on false-to-true transition.
- First valid sample is a baseline. Repeated true or false samples do not
  increment.
- Machine-level total is stored in `machine_monitoring_states`.
- `boolean_count_threshold` has its own persistent counter per rule and asset;
  it does not inherit the machine total or another rule's counter.
- Configure two positive, increasing whole-number warning thresholds and a
  larger positive alert threshold. Warning 1 and Warning 2 both report
  `warning`; the higher stage has its own event. The final threshold reports
  `alert`.

### Running time

- Runtime uses a Boolean running signal, not a cycle pulse. Accumulation uses
  timestamp deltas while the signal is true.
- Machine runtime and `runtime_duration` rule runtime are separate persisted
  counters. Rule counters are scoped by `(rule_id, asset_id)`.
- A false signal pauses accumulation. A stale signal is only trusted until its
  freshness deadline; disconnect time is not inferred. Disabling a runtime
  rule clears its live signal/checkpoint; after reactivation a fresh Boolean
  sample is required before runtime resumes.
- Runtime thresholds are positive and strictly increasing: warning,
  higher-warning, then alert. Asset forms express runtime thresholds in hours;
  the API stores them as seconds.
- Optional `activation_at` delays a runtime rule until the scheduled time. It
  does not cause runtime to accrue before activation.
- Duration/held-state rules measure a configured condition that remains true
  for `duration_seconds`. Their variable condition may be equality or a
  numeric threshold, depending on rule definition and variable type.

## Monitoring rules and lifecycle

The database constraint allows `parameter_threshold`, `runtime_duration`,
`duration`, `generic`, `boolean_condition`, and `boolean_count_threshold`.
`RuleCreate` accepts the same list except `boolean_condition`; compatibility
endpoints and legacy records may have different behavior. Rules created for an
asset must use variables owned by that asset. Runtime/cycle rules must bind to
the matching configured Boolean signal or eligible declared signal in
mapping-bypass mode.

- **parameter_threshold:** numeric comparison; Boolean expected values support
  equality/inequality only.
- **runtime_duration:** supported threshold form uses persistent running
  seconds and three thresholds. Legacy `duration_seconds` forms are retained
  by validation/evaluation paths; review old records before assuming all
  runtime rules use the newer threshold form.
- **duration:** evaluates a condition held for a configured duration. The
  `interval_elapsed` form does not target a variable.
- **boolean_count_threshold:** evaluates the rule-specific cycle counter.
- **generic:** currently has no evaluator and evaluates to `unknown`; it is not
  a functioning monitoring condition.
- **boolean_condition:** allowed by the database constraint but absent from
  `RuleCreate`'s accepted literal list. API compatibility or legacy records
  need verification before creating or relying on this type.

Status values include `normal`, `warning`, `alert`, and `unknown`. A missing
target, inactive asset/variable, no reading, stale/future/invalid reading, or
invalid configuration cannot be represented as normal; it is unknown or an
evaluation error. A per-rule evaluation interval can defer scheduled
evaluation. The default global evaluator interval is 15 seconds and the
default stale window is 300 seconds.

Lifecycle behavior in `frontend_compat.py` and `monitoring_engine.py`:

- **In progress:** enabled/evaluated.
- **Suspended:** disabled by the suspend lifecycle action; can be resumed.
- **Deactivated:** disabled and eligible to reactivate. Disabling transitions
  rule state to unknown and resolves active rule alerts while retaining
  history.
- **Completed:** terminal in the UI/API lifecycle; completed rules cannot be
  reactivated. Create a new rule for a new monitoring period.
- **Archived:** hidden from normal rule lists/evaluation, retains history;
  archive requires a disabled rule. Permanent deletion is an Administrator
  action and is also restricted to disabled rules.

Some endpoints and `set_rule_enabled_state` normalize enabled/disabled states
without expressing every lifecycle label. Use lifecycle endpoints for
suspend/resume/activate/deactivate and verify legacy rule records.

## Alerts and events

- The rule evaluator maintains at most one active alert per rule and target
  asset. A continuing condition updates the active alert, including severity
  changes, instead of creating a row for every evaluator pass.
- Returning to normal resolves an active rule alert. Disabling/deactivating
  resolves active alerts according to the lifecycle service. An `unknown`
  state is not itself proof the condition cleared.
- `acknowledged_at` / `acknowledged_by` record a user's acknowledgement;
  acknowledgement does not clear a rule condition. The alert-complete action
  requires an active acknowledged alert. Completing a rule alert disables and
  marks its rule completed; it is not the same as waiting for the condition to
  return to normal. Completing a maintenance due alert completes the linked
  current occurrence.
- Events record transitions such as rule created, alert triggered/resolved,
  stale data, evaluation failure, machine stopped, lifecycle changes, and
  maintenance actions. The asset Event log applies its own display filtering;
  not every database event is shown in that view.
- Maintenance due-date alerts are warning alerts tied to a schedule and due
  date. A leased evaluator checks once a minute, creates/updates the alert, and
  marks the date alerted. Completing the associated occurrence resolves the
  alert.
- Email notification jobs are enqueued for alert/severity/recipient when
  eligible. Delivery is via a separate retrying SMTP outbox worker and depends
  on settings, recipient assignments, valid addresses, and SMTP availability.

## Maintenance rules

- Individual records use `planned`, `in_progress`, `completed`, and `cancelled`
  statuses. Start/completion record actual timestamps. Completed records are
  read-only in the standard workflow; archival/permanent deletion behavior
  differs between the normal list and Administrator-only actions.
- A schedule belongs to one asset and has a current occurrence/due date.
  Recurrence units are `days`, `weeks`, `months`, and `years`, with a positive
  interval. Schedule creation creates its first planned occurrence.
- After a recurring occurrence, the next proposed due date can be confirmed
  (including a replacement date) or declined. A declined proposal leaves the
  schedule active but requires a replacement date before a next occurrence can
  be created.
- Schedule due state is `upcoming`, `due_today`, `overdue`, `completed`,
  `not_scheduled`, or `awaiting_approval` as applicable. Due dates are
  calendar dates; machine running-hour/cycle-based maintenance is not
  implemented.
- Operators may start/complete only the active current scheduled occurrence
  due today or overdue. They cannot act on an unscheduled occurrence, an older
  occurrence, a pending-approval schedule, or an occurrence not in the
  required status. Administrator/Supervisor management is separately role
  checked.

## Role permissions and scope

The request middleware and endpoint checks define the authoritative role
capabilities. Administrator-only operations include user administration,
system/PLC configuration, permanent deletion, backups, and other privileged
settings. Supervisors may manage monitoring and maintenance with field/action
restrictions. Operators are limited to permitted alert actions and due
scheduled maintenance actions.

The backend README claims access is restricted to assigned machines, but
asset-level query filters and WebSocket assignment filters were not verified
in the inspected code. Confirm this before relying on assignments as a
confidentiality boundary.
