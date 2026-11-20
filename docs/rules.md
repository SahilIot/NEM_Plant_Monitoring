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
- A cycle-count rule is only evaluated while its Boolean source is current. If the
  last confirmed sample is older than the freshness limit (or the rule has never
  received one) the status is `unknown` (Not evaluated) with error `stale_reading`
  or `cycle_signal_unavailable`. The limit is the same one running-time rules use:
  the rule's (or default) stale window, tightened to the runtime freshness limit
  for readings written by the OPC UA collector, which refreshes cycle signals each
  checkpoint while connected. Readings pushed through the API or entered manually
  keep the rule/default stale window only. While Not evaluated the counter is not
  reset, its last value and stage are kept, and existing alerts stay active; the
  next fresh sample re-evaluates the thresholds immediately and restores
  Normal, Warning or Alert without a duplicate trigger event for an alert that
  is still active.

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
`duration`, `generic`, `boolean_condition`, `boolean_count_threshold` and
`multi_parameter` (see [Multi-parameter rules](#multi-parameter-rules)).
`RuleCreate` accepts the same list except `boolean_condition` and
`multi_parameter`, which has its own endpoint. `generic` and
`boolean_condition` have no evaluator; the engine reports them as unknown and
they never raise or clear alerts. On startup the PostgreSQL constraint is
widened if an older database lacks any of these types. Rules created for an
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

Lifecycle behavior in `services/rule_lifecycle.py` (called from `frontend_compat.py` and `rule_parameters.py`) and `monitoring_engine.py`:

- **In progress:** enabled/evaluated.
- **Suspended:** disabled by the suspend lifecycle action; can be resumed.
- **Deactivated:** disabled and eligible to reactivate. Disabling transitions
  rule state to unknown and resolves active rule alerts while retaining
  history.
- **Completed:** terminal in the UI/API lifecycle; completed rules cannot be
  reactivated. Create a new rule for a new monitoring period.
- **Permanent deletion:** an Administrator action restricted to disabled
  rules; it removes the rule and its associated evaluation and alert history
  subject to linked maintenance-record constraints.

Some endpoints and `set_rule_enabled_state` normalize enabled/disabled states
without expressing every lifecycle label. Use lifecycle endpoints for
suspend/resume/activate/deactivate and verify legacy rule records.

## Multi-parameter rules

Rules of type `multi_parameter` (created with
`POST /assets/{id}/multi-parameter-rules`, replaced with `PUT /rules/{id}/parameters`,
edited with `PATCH /rules/{id}/parameters/{pid}`) hold from one to 20 independently
configured parameters. Validation is in `app/schemas/rule_parameters.py`,
evaluation in `app/services/rule_parameters.py`. A rule has one **category**:
`parameter_threshold` or `interval_based`, and an optional calculation period
(`calculation_period_seconds`, 1 second to one year).

Parameter kinds (`kind`):

- **number:** at least one Warning and one Alert limit among `lower_alert`,
  `lower_warning`, `upper_warning`, `upper_alert`. Lower Alert < Lower Warning,
  Upper Warning < Upper Alert, and every lower limit below every upper limit.
  Needs a variable. Limits are inclusive (`>=` upper, `<=` lower); alert limits
  are checked before warning limits.
- **boolean:** an `expected` state (true/false) and a `severity` of `warning` or
  `alert` raised when the state differs. Needs a variable.
- **interval:** a progress value compared with `due` and `overdue`
  (Overdue must exceed Due). Reaching Due gives `warning`, reaching Overdue
  gives `alert`. The `interval_parameter` is one of:
  - `usage`: running hours from a Boolean running signal; needs a variable with
    `timer` aggregation.
  - `time` (elapsed): hours elapsed since the rule's creation or an optional
    `activation_at`, with no variable, or from a running signal with `timer`
    aggregation.
  - `time` with `time_mode: calendar` (**Calendar Time**): Due and Overdue are
    whole numbers of `time_unit` (`days`, `weeks`, `months` or `years`) after a
    `start_date` / `start_at`; no PLC variable and aggregation `none`. After a
    completion with reset, or a manual reset, the cycle restarts from that
    moment. Its dates are computed by `calendar_cycle()`; the last reset is the
    later of the latest reset-completed schedule's completion and the manual
    baseline.
  - `counter`: false-to-true cycles; Due and Overdue are whole numbers and the
    parameter needs a variable with `counter` aggregation.

Aggregation values are `none`, `counter`, `last` and `timer`. A number
parameter with `counter` or `timer` aggregation evaluates the count or running
seconds over the rule's calculation period (3600 seconds when unset); `last`
uses the latest reading, which must lie inside the period when one is set.

A parameter is `unknown`, never `normal`, when its stored configuration is
invalid, or when it uses a variable and that variable is missing or inactive,
has no reading, has a stale latest reading, or has a value of the wrong type.
Parameters without a PLC variable are not judged this way: an elapsed Time
interval (no variable) counts hours since its start, and a Calendar Time
interval is decided from calendar dates, so neither becomes `unknown` for
missing or stale readings (an invalid stored configuration still does). The overall rule status is
the most severe parameter status; `determined_by` lists the parameters that set
it. Each parameter has its own alert and state.

Each parameter has a lifecycle of `active`, `suspended` or `deactivated`
(`POST /rules/{id}/parameters/{pid}/lifecycle`, actions `suspend`, `resume`,
`deactivate`, `activate`; `activate` needs an Administrator or Supervisor, the
other actions an Administrator; for older single-parameter rules the call acts
on the whole rule). Suspending or deactivating resolves that
parameter's open alert, keeps its history and stops its evaluation and progress;
a parameter must pass validation again before it is activated. Progress of an
interval parameter counts from the later of the rule's creation/activation and
the start of its current cycle (`RuleParameter.cycle_baseline_at`, set only by a
confirmed reset). Manual reset and completion behaviour are in
[rule-operations.md](rule-operations.md).

Interval-based rules generate maintenance schedules (schedule mode `rule`); see
[maintenance.md](maintenance.md).

## Shared labels

- Labels are optional and reusable across asset-specific monitoring rules,
  reusable rule templates, rule collections, and instruction documents.
- Entry saves accept label names and resolve them to shared catalog IDs. Names
  are whitespace-normalized and compared case-insensitively; a unique
  normalized key prevents concurrent requests from creating duplicate labels.
  Duplicate names in one selection are collapsed.
- Each entry may have at most 10 labels. A save replaces that entry's
  associations with the submitted selection. Removing a label from an entry
  does not delete the shared label or affect other entries.
- Listing filters accept repeated `label_ids` parameters and use AND behavior:
  a result must have every selected label. This applies to rules, reusable
  templates, collections, and documents, alongside their existing filters.
- Legacy document label JSON is imported into shared label associations during
  the `001_shared_labels` startup migration. The old column remains for
  compatibility; downgrade copies current associations back before removing
  the shared tables.
- Authorization remains governed by each entry's existing route permission.
  Collection and document metadata updates are Administrator-only; rule and
  template updates continue to use their existing role restrictions. Creating
  instructions and uploading documents is open to Administrators and
  Supervisors; an instruction never requires an attachment. Removing a rule
  from a collection is not an operation: a collection owns its rules.

## Shared rule visibility and editing

Shared (reusable) rules are stored in `nem_monitoring_rule_templates`. Three
checks apply, and none implies another:

- **Visibility:** `admin_only` or `specific_supervisors` (the Supervisors
  listed for that rule); there is no all-Supervisors value and creation needs
  an explicit choice. Administrators see
  every shared rule; Operators see none. Only an Administrator changes
  visibility or the Supervisor list (`PUT /rule-templates/{id}/visibility`).
  There is no request or approval workflow, and
  `/api/v1/rule-visibility-requests` answers 404 for every role. An unknown
  stored value is treated as `admin_only`.
- **Editing:** a Supervisor who can see a rule may change only its numeric
  thresholds (`threshold`, the threshold keys inside `parameters`, and
  `evaluation_interval_seconds`); any other change answers 403. Creating and
  deleting shared rules is Administrator-only.
- **Assignment:** assigning a shared rule to an asset needs an assigning role,
  visibility of the rule and access to the target asset.

A rule the caller may not see answers 404, identical to a missing rule, in
listings, pickers, search, predefined-rule lists, assignment and history.
`source_template_id` on asset rule rows is returned only to roles that may see
that shared rule. Editing a shared rule propagates to the asset rules created
from it, including assets the editor cannot reach; error messages for
non-Administrators never name assets.

Each edit is recorded field by field (previous value, new value, editor, UTC
time) in `nem_rule_template_changes`; saves that change nothing are not
recorded. Visibility changes are recorded with previous and new values in
`nem_rule_visibility_changes` and are shown to Administrators only.
`GET /rule-templates/{id}/history` returns the timeline and
`GET /rule-templates/{id}/assignments` lists the assets using the rule, limited
to the caller's asset scope. Rows written before the request feature was
removed may still carry the source `request`.

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
- Editing a rule (or a shared rule, for every asset using it) re-evaluates it at
  once with the latest stored value and the new thresholds through the normal
  evaluator: Warning/Alert may change severity or return to Normal, an existing
  alert is updated or resolved (never duplicated, history kept), and the changes
  are published to the Overview through the live-update hub. Disabled rules are
  not re-evaluated.
- Maintenance due-date alerts are warning alerts tied to a schedule and due
  date. A leased evaluator checks once a minute, creates/updates the alert, and
  marks the date alerted. Completing the associated occurrence resolves the
  alert.
- Email notification jobs are enqueued for alert/severity/recipient when
  eligible. Delivery is via a separate retrying SMTP outbox worker and depends
  on settings, recipient assignments, valid addresses, and SMTP availability.
  Direct supervisors selected on the alert's asset take precedence. Parent
  assignments are inherited only when the alert asset has no direct supervisor
  assignments. At delivery time, pending jobs are checked against this effective
  recipient set; removed or superseded recipients are skipped.

## Maintenance rules

See also [maintenance.md](maintenance.md) for schedule modes (including
rule-generated schedules), cancellation, and what Administrators may delete.

- Individual records use `planned`, `in_progress`, `completed`, and `cancelled`
  statuses. Start/completion record actual timestamps. Completed records are
  read-only in the standard workflow. Maintenance records remain in normal
  listings after completion; Administrator deletion removes eligible records
  permanently.
- A schedule belongs to one asset and has a current occurrence/due date.
  Recurrence units are `days`, `weeks`, `months`, and `years`, with a positive
  interval. Schedule creation creates its first planned occurrence.
- After a recurring occurrence, the next proposed due date can be confirmed
  (including a replacement date) or declined. A declined proposal leaves the
  schedule active but requires a replacement date before a next occurrence can
  be created.
- Schedule due state is `upcoming`, `due_today`, `overdue`, `completed`,
  `not_scheduled`, or `awaiting_approval` as applicable. Due dates are
  calendar dates. Runtime (`running` signal, hours) and usage (`cycle` signal,
  cycles) schedules are due when accumulated progress reaches the interval; they
  create no occurrence up front and their occurrence has no due date, so it is due
  immediately. Progress counts only fresh samples (runtime: previous sample true
  and at most the runtime freshness limit, 30 s by default, before the new one, never across
  a PLC outage or bad-quality reads, and a runtime rule's live runtime is never projected beyond that
  limit after its last confirmed sample; usage: confirmed false→true within the stale window), is never changed by
  editing the schedule, and resets only when an occurrence is completed.
- Start acts only on the schedule's own planned occurrence (no ad-hoc job is
  created), is row-locked against duplicate requests, and a started scheduled job
  stays in Current status until completed. Completion requires only the actual
  completion time; other registration fields are optional.
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

Supervisors and Operators can see and act on only their assigned assets and
those assets' descendants; the filter is applied in the REST routes and in
WebSocket events, and a non-admin with no assignments sees nothing. Asset scope and shared-rule visibility are independent: seeing a rule never grants access to an asset, and the reverse. Only
assigned Supervisors receive alert emails. Assignment scope was verified by code
review and compilation, not by a live multi-role test.
