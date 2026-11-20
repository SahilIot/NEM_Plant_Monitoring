import React, { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { createLiveUpdateScheduler, shareInFlight, subscribeLiveUpdates } from "../../../services/liveUpdates.js";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import { NUMBER_LIMITS, makeLimitScale, numberZone } from "./parameterRules.js";
import { calendarProgress, formatCalendarMoment, formatCalendarSpan, formatDuration, liveHours, useDisplayClock } from "./durationClock.js";
import ParameterCardMenu from "./ParameterCardMenu.jsx";
import { confirmAndResetProgress } from "./intervalReset.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { useConfirmation } from "../../../components/common/UI.jsx";
import "./IntervalDemo.css";
import "./ParameterDemos.css";
import "./RuleStatusDetail.css";
import { useTips } from "./useTips.js";

/*
 * Current Status detail view of one parent multi-parameter rule.
 *
 * Every status, value and alert shown here comes from GET /rules/{id}/status-detail. The component only
 * lays the numbers out (positions on a scale); it never decides Normal / Warning / Alert itself, so it
 * cannot disagree with the backend's worst-parameter calculation.
 */

const STATUS_LABEL = { normal: "Normal", warning: "Warning", alert: "Alert", unknown: "Not evaluated" };
const LIFECYCLE_LABEL = {
  in_progress: "Active", suspended: "Suspended", deactivated: "Deactivated", completed: "Completed",
};
const AGGREGATION_LABEL = { none: "None (latest value)", last: "Last value", timer: "Timer (seconds ON)", counter: "Counter (OFF→ON)", };
const RELEVANT_TABLES = new Set([
  "nem_rule_states", "nem_rule_parameter_states", "nem_rule_parameters", "nem_alerts", "nem_monitoring_rules",
]);
const FALLBACK_POLL_MS = 30000;

const round = (value) => Math.round(Number(value) * 1000) / 1000;
const fmt = (value, unit) => (value === null || value === undefined || Number.isNaN(Number(value))
  ? "—" : `${round(value)}${unit ? ` ${unit}` : ""}`);
// Interval durations in hours are shown as HH:MM:SS; cycle counts and other units stay as numbers.
const amount = (value, unit) => (value === null || value === undefined || Number.isNaN(Number(value))
  ? "—" : unit === "hours" ? formatDuration(value) : fmt(value, unit));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "—");
function age(seconds) {
  if (seconds === null || seconds === undefined) return "never";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}
const periodText = (seconds) => {
  if (!seconds) return "—";
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} s`;
};

// Keep the identity of everything that did not change so only the affected parameter card re-renders.
function mergeDetail(previous, next) {
  if (!previous) return next;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const byId = new Map(previous.parameters.map((p) => [p.id, p]));
  return {
    rule: same(previous.rule, next.rule) ? previous.rule : next.rule,
    overall: same(previous.overall, next.overall) ? previous.overall : next.overall,
    parameters: next.parameters.map((p) => (byId.has(p.id) && same(byId.get(p.id), p) ? byId.get(p.id) : p)),
    server_time: next.server_time,
  };
}

/** Scale with coloured zones, boundary markers and the value marker. All positions are layout only. */
function LimitGauge({ zones, markers, label }) {
  const baseId = useId();
  const { open, point } = useTips();
  const edge = (p) => (p < 22 ? "is-start" : p > 78 ? "is-end" : "");
  return (
    <div className="interval-demo-stage rsd-gauge" role="group" aria-label={label}>
      <div className="interval-demo-bar" aria-hidden="true">
        {zones.map((z, i) => (
          <span key={i} className={`interval-demo-region ${z.cls}`} style={{ width: `${z.to - z.from}%` }}>
            {z.to - z.from > 12 && z.label}
          </span>
        ))}
      </div>
      {markers.map((m) => (
        <button key={m.key} type="button" className={`${m.cls}${open === m.key ? " is-open" : ""}`}
          style={{ left: `${m.pct}%` }} aria-label={`${m.name}: ${m.lines.join(". ")}`} {...point(m.key, baseId)} />
      ))}
      {markers.map((m) => (
        <div key={m.key} id={`${baseId}-tip-${m.key}`} role="tooltip"
          className={`interval-demo-tip ${edge(m.pct)}${open === m.key ? " is-visible" : ""}`} style={{ left: `${m.pct}%` }}>
          <strong>{m.name}</strong>{m.lines.map((l) => <span key={l}>{l}</span>)}
        </div>
      ))}
      <div className="interval-demo-scale rsd-scale" aria-hidden="true">
        {markers.filter((m) => m.scale !== undefined).map((m) => (
          <span key={m.key} style={{ left: `${m.pct}%` }}>{m.scale}</span>
        ))}
      </div>
    </div>
  );
}

const ZONE_CLASS = { normal: "region-normal", lower_warning: "region-due", upper_warning: "region-due", lower_alert: "region-overdue", upper_alert: "region-overdue" };

const wordFor = (status, interval) => (interval
  ? { normal: "Normal", warning: "Due", alert: "Overdue", unknown: "Not evaluated" }
  : STATUS_LABEL)[status];

function NumberVisual({ p }) {
  const limits = p.config || {};
  const active = Object.fromEntries(NUMBER_LIMITS
    .filter(({ key }) => limits[key] !== null && limits[key] !== undefined && Number.isFinite(Number(limits[key])))
    .map(({ key }) => [key, Number(limits[key])]));
  const points = NUMBER_LIMITS.filter(({ key }) => active[key] !== undefined).map((item) => ({ ...item, value: active[item.key] }));
  if (!points.length) return <p className="rsd-note">No limits are configured.</p>;
  const unit = p.unit || "";
  const hasValue = (p.status !== "unknown" || p.paused) && p.value !== null && p.value !== undefined;
  const current = hasValue ? Number(p.value) : null;
  const scale = makeLimitScale(points.map((x) => x.value));
  const pct = scale.pct;
  // One zone per gap between consecutive limits, plus the open-ended regions before the first / after the last.
  const probes = [scale.limits[0] - 1, ...scale.limits.slice(1).map((v, i) => (v + scale.limits[i]) / 2), scale.limits[scale.limits.length - 1] + 1];
  const zones = probes.map((probe, i) => ({
    from: scale.edges[i], to: scale.edges[i + 1], cls: ZONE_CLASS[numberZone(probe, active)] || "region-normal", label: "",
  }));
  const markers = points.map((x) => ({
    key: x.key, name: x.label, pct: pct(x.value),
    cls: `interval-demo-limit ${x.key.endsWith("alert") ? "limit-overdue" : "limit-due"}`,
    lines: [`${x.label}: ${fmt(x.value, unit)}`, `Meaning: ${x.meaning}`],
  }));
  if (hasValue) {
    markers.push({ key: "value", name: "Current value", pct: pct(current), cls: "interval-demo-marker",
      lines: [`Current value: ${fmt(current, unit)}`, `Status: ${STATUS_LABEL[p.status]}`] });
  }
  const side = (label, warning, alert, sign) => [
    warning !== undefined ? `warning ${sign} ${warning}` : null,
    alert !== undefined ? `alert ${sign} ${alert}` : null,
  ].filter(Boolean).join(", ") && `${label}: ${[warning !== undefined ? `warning ${sign} ${warning}` : null, alert !== undefined ? `alert ${sign} ${alert}` : null].filter(Boolean).join(", ")}`;
  const parts = [side("Low", active.lower_warning, active.lower_alert, "≤"), side("High", active.upper_warning, active.upper_alert, "≥")].filter(Boolean);
  return (
    <>
      <LimitGauge zones={zones} markers={markers} label={`${p.name} limits and current value`} />
      <p className="rsd-limits">{parts.join(" · ")}</p>
    </>
  );
}

function IntervalVisual({ p }) {
  const config = p.config || {};
  const due = Number(config.due), overdue = Number(config.overdue);
  const unit = p.unit || "";
  if (!Number.isFinite(due) || !Number.isFinite(overdue)) return <p className="rsd-note">No Due / Overdue limits are configured.</p>;
  const hasValue = (p.status !== "unknown" || p.frozen || p.paused) && p.value !== null && p.value !== undefined;
  const current = hasValue ? Number(p.value) : null;
  const max = Math.max(overdue * 1.2, (current || 0) * 1.08);
  const pct = (v) => Math.min(100, Math.max(0, (v / max) * 100));
  const zones = [
    { from: 0, to: pct(due), cls: "region-normal", label: "Normal" },
    { from: pct(due), to: pct(overdue), cls: "region-due", label: "Due" },
    { from: pct(overdue), to: 100, cls: "region-overdue", label: "Overdue" },
  ];
  const markers = [
    { key: "due", name: "Due boundary", pct: pct(due), cls: "interval-demo-limit limit-due",
      lines: [`Due at ${amount(due, unit)}`, "Maintenance is due at this value."] },
    { key: "overdue", name: "Overdue boundary", pct: pct(overdue), cls: "interval-demo-limit limit-overdue",
      lines: [`Overdue at ${amount(overdue, unit)}`, "Maintenance is overdue from this value."] },
  ];
  if (hasValue) {
    const remaining = current < due ? `${amount(due - current, unit)} until Due`
      : current < overdue ? `${amount(overdue - current, unit)} until Overdue` : `${amount(current - overdue, unit)} past Overdue`;
    markers.push({ key: "value", name: "Current progress", pct: pct(current), cls: "interval-demo-marker",
      lines: [`Progress: ${amount(current, unit)}`, `Status: ${wordFor(p.status, true)}`, remaining] });
  }
  return (
    <>
      <LimitGauge zones={zones} markers={markers} label={`${p.name} progress`} />
      <p className="rsd-limits">Due: {amount(due, unit)} · Overdue: {amount(overdue, unit)}</p>
    </>
  );
}

const isCalendarParameter = (p) => p.kind === "interval" && p.config?.time_mode === "calendar" && p.schedule?.mode === "calendar_date";

// Calendar Time card body: baseline, live elapsed time and exact Due / Overdue moments. Everything is derived from the
// backend's saved Calendar Start and calendar-computed due/overdue instants; the shared clock only drives re-renders.
function CalendarVisual({ p }) {
  const c = p.calendar;
  if (!c) return <p className="rsd-note">Calendar Start or limits are not available.</p>;
  const paused = Boolean(p.paused);
  const moment = (ms) => formatCalendarMoment(ms, c.dateOnly);
  const span = c.overdue - c.start;
  const pct = (ms) => Math.min(100, Math.max(0, ((ms - c.start) / span) * 100));
  const nowPct = pct(c.start + c.elapsedMs);
  const zones = [
    { from: 0, to: pct(c.due), cls: "region-normal", label: "Normal" },
    { from: pct(c.due), to: pct(c.overdue), cls: "region-due", label: "Due" },
    { from: pct(c.overdue), to: 100, cls: "region-overdue", label: "Overdue" },
  ];
  const remaining = c.phase === "normal" ? `Due in ${formatCalendarSpan(c.toDueMs)}`
    : c.phase === "due" ? `Overdue in ${formatCalendarSpan(c.toOverdueMs)}` : `Overdue for ${formatCalendarSpan(c.pastOverdueMs)}`;
  const markers = [
    { key: "due", name: "Due boundary", pct: pct(c.due), cls: "interval-demo-limit limit-due", lines: [`Due: ${moment(c.due)}`] },
    { key: "overdue", name: "Overdue boundary", pct: Math.min(99.5, pct(c.overdue)), cls: "interval-demo-limit limit-overdue", lines: [`Overdue: ${moment(c.overdue)}`] },
  ];
  if (!c.notStarted) {
    markers.push({ key: "value", name: "Current progress", pct: Math.min(99.5, nowPct), cls: "interval-demo-marker",
      lines: [`Elapsed: ${formatCalendarSpan(c.elapsedMs)}`, paused ? "Paused" : remaining] });
  }
  return (
    <>
      <p className="rsd-value">
        <span>{c.notStarted ? "Starts in" : paused ? "Elapsed when paused" : "Elapsed"}</span>
        <b>{formatCalendarSpan(c.notStarted ? c.toStartMs : c.elapsedMs)}</b>
      </p>
      <LimitGauge zones={zones} markers={markers} label={`${p.name} calendar progress`} />
      <dl className="rsd-facts rsd-calendar-facts">
        <div><dt>Calendar Start</dt><dd>{moment(c.start)}</dd></div>
        <div><dt>Due</dt><dd>{moment(c.due)}</dd></div>
        <div><dt>Overdue</dt><dd>{moment(c.overdue)}</dd></div>
        {!paused && <div><dt>{c.phase === "overdue" ? "Overdue for" : c.phase === "due" ? "Overdue in" : "Due in"}</dt>
          <dd>{formatCalendarSpan(c.phase === "overdue" ? c.pastOverdueMs : c.phase === "due" ? c.toOverdueMs : c.toDueMs)}</dd></div>}
      </dl>
    </>
  );
}

function BooleanVisual({ p }) {
  const expected = Boolean((p.config || {}).expected);
  const valid = p.status !== "unknown" && typeof p.value === "boolean";
  return (
    <>
      <div className="rsd-bool" role="group" aria-label={`${p.name} state`}>
        <span className={`rsd-pill${valid ? (p.value === expected ? " is-ok" : " is-bad") : " is-na"}`}>
          Now: <b>{valid ? (p.value ? "TRUE" : "FALSE") : "Unavailable"}</b>
        </span>
        <span className="rsd-pill">Expected: <b>{expected ? "TRUE" : "FALSE"}</b></span>
      </div>
      {!valid && <p className="rsd-limits">No valid signal — shown as unavailable, not as FALSE.</p>}
    </>
  );
}

function AlertLine({ alert }) {
  return (
    <li className={`rsd-alert is-${alert.severity}`}>
      <span className={`rsd-chip is-${alert.severity}`}>{STATUS_LABEL[alert.severity]}</span>
      <div>
        <strong>{alert.message}</strong>
        <small>
          Value {fmt(alert.trigger_value)} · {alert.threshold !== null && alert.threshold !== undefined ? `limit ${fmt(alert.threshold)} · ` : ""}
          {when(alert.started_at)} · {alert.workflow === "completed" ? `completed ${when(alert.resolved_at)}`
            : alert.workflow === "acknowledged" ? `acknowledged by ${alert.acknowledged_by || "user"}` : "awaiting acknowledgement"}
        </small>
      </div>
    </li>
  );
}

// Cards with a live duration subscribe to the shared one-second clock; all other cards never re-render on it.
const ParameterCard = memo(function ParameterCard(props) {
  return props.p.kind === "interval" ? <ClockedParameterCard {...props} /> : <ParameterCardView {...props} />;
});

function ClockedParameterCard({ p, getOffsetMs, ...rest }) {
  const clock = useDisplayClock();
  const shown = useRef({ hours: null, baseline: null });
  const previous = shown.current;
  // Signal stale / unavailable while the rule is active: freeze at the last accumulated value shown, never
  // advance and never treat the gap as running time. (Counters have no live mode and just show the backend value.)
  const frozen = p.status === "unknown" && ["stale", "unavailable", "variable_inactive", "awaiting_reading"].includes(p.availability) && previous.hours !== null;
  if (frozen) {
    return <ParameterCardView p={{ ...p, value: previous.hours, frozen: true }} {...rest} />;
  }
  if (isCalendarParameter(p)) {
    const now = clock + getOffsetMs();
    return <ParameterCardView p={{ ...p, value: null, calendarNow: now, calendar: calendarProgress(p.schedule, now) }} {...rest} />;
  }
  const computed = liveHours(p, clock + getOffsetMs());
  let hours = computed;
  if (typeof computed === "number" && previous.hours !== null) {
    if (p.live && previous.baseline === p.live.baseline_at) {
      hours = Math.max(computed, previous.hours); // same baseline: time only moves forward
    } else if (computed < previous.hours && previous.hours - computed < 3 / 3600) {
      hours = previous.hours; // new backend baseline slightly behind the local clock: hold, don't jump back
    }
  }
  shown.current = { hours: typeof hours === "number" ? hours : null, baseline: p.live?.baseline_at ?? null };
  return <ParameterCardView p={{ ...p, value: hours }} {...rest} />;
}

function ParameterCardView({ p: source, rule, ruleId, determining, onEdit, onChanged, onOpenSchedule }) {
  // A suspended/deactivated parameter keeps its preserved progress on screen but has no status.
  const paused = source.availability === "suspended" || source.availability === "deactivated";
  const p = paused ? { ...source, paused: true } : source;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const interval = p.kind === "interval";
  const unit = p.unit || "";
  const hasValue = (p.status !== "unknown" || p.frozen || paused) && p.value !== null && p.value !== undefined;
  const calendarCard = p.calendar !== undefined;
  const valueText = p.kind === "boolean" || calendarCard ? null : hasValue ? amount(p.value, unit) : "—";
  const sched = p.schedule || {};
  const [scheduleNote, setScheduleNote] = useState("");
  const [openingSchedule, setOpeningSchedule] = useState(false);
  // Opens this parameter's rule-generated maintenance schedule in the Maintenance Logbook; nothing is created here.
  const openSchedule = async () => {
    if (!onOpenSchedule || openingSchedule) return;
    setOpeningSchedule(true);
    setScheduleNote("");
    try {
      const message = await onOpenSchedule(p);
      if (message) setScheduleNote(message);
    } finally {
      setOpeningSchedule(false);
    }
  };
  const stateWord = paused ? (p.availability === "suspended" ? "Suspended" : "Deactivated") : wordFor(p.status, interval);
  return (
    <article className={`rsd-param is-${p.status}${paused ? " is-paused" : ""}${determining ? " is-determining" : ""}`} aria-label={`${p.name}: ${stateWord}`}>
      <header>
        {onOpenSchedule ? (
          <button type="button" className="rsd-param-title rsd-param-link" onClick={openSchedule} disabled={openingSchedule}
            title="Open this parameter's maintenance schedule" aria-label={`${p.name}: open maintenance schedule`}>
            <strong>{p.name}</strong>
            <small>{p.variable_name || (interval ? "Calendar based" : "")}</small>
          </button>
        ) : (
          <span className="rsd-param-title">
            <strong>{p.name}</strong>
            <small>{p.variable_name || (interval ? "Calendar based" : "")}</small>
          </span>
        )}
        <span className="rsd-param-head-right">
          {p.availability === "stale" && <span className="rsd-badge is-stale">Stale</span>}
          {p.availability === "variable_inactive" && <span className="rsd-badge is-stale">Variable inactive</span>}
          {p.availability === "awaiting_reading" && <span className="rsd-badge is-stale">Awaiting fresh reading</span>}
          <span className={`rsd-chip is-${paused ? "paused" : p.status}`}>{stateWord}</span>
          {onEdit && (
            <ParameterCardMenu ruleId={ruleId} rule={rule} p={p} detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen((open) => !open)} onEdit={() => onEdit(p)} onChanged={onChanged} />
          )}
        </span>
      </header>
      {scheduleNote && <p className="rsd-note" role="status">{scheduleNote}</p>}
      {valueText !== null && (
        <p className="rsd-value">
          {(interval || paused) && <span>{p.frozen ? "Last valid progress" : paused ? (interval ? "Progress when paused" : "Last value") : "Current progress"}</span>}
          <b>{valueText}</b>
          {p.frozen && <span className="rsd-frozen">frozen — {p.availability === "variable_inactive" ? "variable inactive" : p.availability === "awaiting_reading" ? "awaiting a fresh reading" : `signal ${p.availability === "stale" ? "stale" : "unavailable"}`}</span>}
        </p>
      )}
      {p.kind === "number" && <NumberVisual p={p} />}
      {interval && (calendarCard ? <CalendarVisual p={p} /> : <IntervalVisual p={p} />)}
      {p.kind === "boolean" && <BooleanVisual p={p} />}
      {p.active_alert && (
        <p className={`rsd-active-alert is-${p.active_alert.severity}`} role="status">
          {p.active_alert.message}
        </p>
      )}
      {detailsOpen && (
        <div className="rsd-param-body" aria-label={`Technical details for ${p.name}`}>
          <dl className="rsd-facts">
            <div><dt>Connected variable</dt><dd>{p.variable_name || "None (calendar based)"}</dd></div>
            <div><dt>Raw PLC value</dt><dd>{p.raw_value === null || p.raw_value === undefined ? "—" : String(p.raw_value)}</dd></div>
            <div><dt>Aggregated value</dt><dd>{p.kind === "boolean" ? (typeof p.value === "boolean" ? String(p.value).toUpperCase() : "—") : amount(p.value, unit)}</dd></div>
            <div><dt>Aggregation</dt><dd>{AGGREGATION_LABEL[p.aggregation] || p.aggregation}</dd></div>
            <div><dt>Calculation period</dt><dd>{interval ? "Cumulative since activation" : p.aggregation === "none" ? "Latest reading" : periodText(rule.calculation_period_seconds)}</dd></div>
            <div><dt>Last valid reading</dt><dd>{p.last_valid_at ? `${fmt(p.last_valid_value)} · ${when(p.last_valid_at)}` : "None yet"}</dd></div>
            <div><dt>Signal freshness</dt><dd className={p.is_stale ? "is-bad" : ""}>{p.variable_id ? `${p.is_stale ? "Stale — " : "Fresh — "}latest reading ${age(p.reading_age_seconds)}` : "Calendar based"}</dd></div>
            <div><dt>Last evaluation</dt><dd>{when(p.last_evaluated_at)}</dd></div>
            {sched.start_at && <div><dt>{calendarCard ? "Calendar Start" : "Counting since"}</dt><dd>{calendarCard ? formatCalendarMoment(sched.start_at, /^\d{4}-\d{2}-\d{2}$/.test(String(sched.start_at))) : when(sched.start_at)}</dd></div>}
            {sched.due_at && <div><dt>Due date</dt><dd>{when(sched.due_at)}</dd></div>}
            {sched.overdue_at && <div><dt>Overdue date</dt><dd>{when(sched.overdue_at)}</dd></div>}
          </dl>
          <section className="rsd-alerts" aria-label={`Alerts for ${p.name}`}>
            <h4>Alert history</h4>
            {p.alert_history.length === 0 ? <p className="rsd-note">No alerts from this parameter.</p>
              : <ul>{p.alert_history.map((a) => <AlertLine key={a.id} alert={a} />)}</ul>}
          </section>
        </div>
      )}
    </article>
  );
}

function summaryMessage(detail) {
  const { overall, rule, parameters } = detail;
  const n = overall.parameter_count;
  const plural = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  if (overall.mode === "all_suspended") return "All parameters are suspended — nothing is being evaluated.";
  if (overall.mode === "all_deactivated") return "All parameters are deactivated — nothing is being evaluated.";
  if (overall.mode === "no_active_parameters") return "No parameter is being evaluated (suspended or deactivated).";
  if (!overall.evaluating) return `Rule is ${LIFECYCLE_LABEL[rule.lifecycle_status] || "inactive"} — parameters are not being evaluated.`;
  // Only parameters that are actually evaluated count towards the summary.
  const live = parameters.filter((p) => p.evaluating);
  const off = [
    overall.counts?.suspended ? `${overall.counts.suspended} suspended` : "",
    overall.counts?.deactivated ? `${overall.counts.deactivated} deactivated` : "",
  ].filter(Boolean).join(" · ");
  const withOff = (text) => (off ? `${text} · ${off}` : text);
  const attention = live.filter((p) => p.status === "warning" || p.status === "alert").length;
  const unknown = live.filter((p) => p.status === "unknown").length;
  if (attention) {
    const base = attention === 1 ? "1 parameter requires attention" : `${attention} parameters require attention`;
    return withOff(unknown ? `${base} · ${plural(unknown, "parameter", "parameters")} not evaluated` : base);
  }
  if (unknown) return withOff(`${plural(unknown, "parameter", "parameters")} not evaluated`);
  if (off) return withOff(live.length === 1 ? "The evaluated parameter is Normal" : `All ${live.length} evaluated parameters are Normal`);
  return n === 1 ? "The parameter is Normal" : `All ${n} parameters are Normal`;
}

// Chip of the parent rule: Not evaluated is never shown as Normal, and "nothing active" says why.
const overallWord = (overall, interval) => (
  overall.mode === "all_suspended" ? "Suspended" : overall.mode === "all_deactivated" ? "Inactive" : wordFor(overall.status, interval));

// The only thing besides live durations that follows the clock: whether updates have stopped arriving.
function LiveStatus({ connected, lastSync, staleLimit }) {
  const clockNow = useDisplayClock();
  const outdated = lastSync !== null && (clockNow - lastSync) / 1000 > staleLimit + FALLBACK_POLL_MS / 1000;
  const text = connected ? (outdated ? "Data may be outdated" : "Live") : "Reconnecting…";
  return (
    <span className={`rsd-live ${connected && !outdated ? "is-live" : "is-off"}`} role="status"
      title={`Last updated ${clock(lastSync)}`}>
      {text}{connected && !outdated ? "" : ` · updated ${clock(lastSync)}`}
    </span>
  );
}

export default function RuleStatusDetail({ ruleId, refreshToken = 0, onEditParameter = null }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const [connected, setConnected] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirmation();
  const [resetState, setResetState] = useState({ busy: false, message: "", error: "" });
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const parameterIds = useRef(new Set());
  const ruleAssetId = useRef(null);
  // Finds the schedule generated for one parameter and opens it in the existing Maintenance Logbook details page.
  // Returns a message when there is nothing to open, so an unrelated schedule is never shown.
  const openParameterSchedule = useCallback(async (parameter) => {
    const assetId = ruleAssetId.current;
    if (assetId === null || assetId === undefined) return "The asset of this rule is not loaded yet.";
    let schedules;
    try {
      schedules = await shareInFlight(`maintenance-schedules:${assetId}`, () => api.getAll(`/maintenance/schedules?asset_id=${assetId}`), { fresh: true });
    } catch (e) {
      return e.message || "Could not load the maintenance schedules.";
    }
    const linked = (Array.isArray(schedules) ? schedules : []).filter(
      (schedule) => schedule.schedule_mode === "rule" && Number(schedule.source_parameter_id) === Number(parameter.id)
    );
    // The live schedule is the one that is not cancelled/completed; fall back to the newest one so history stays reachable.
    const target = linked.find((schedule) => schedule.status !== "cancelled" && schedule.status !== "completed")
      || [...linked].sort((a, b) => b.id - a.id)[0];
    if (!target) return "No maintenance schedule exists for this parameter.";
    const here = locationRef.current;
    navigate(`/assets/${target.asset_id ?? assetId}/maintenance/schedules/${target.id}/details`, {
      state: { from: captureNavigationOrigin(here, { ...(here.state || {}), activeTab: "status" }) },
    });
    return "";
  }, [navigate]);
  // Server-minus-browser clock offset, so live durations follow the backend's time, not a skewed local clock.
  const offsetRef = useRef(null);
  const getOffsetMs = useCallback(() => offsetRef.current ?? 0, []);

  // Only the newest request may update the screen: a slower, older response never replaces newer data.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const next = await api.get(`/rules/${ruleId}/status-detail`);
      if (mine !== loadSeq.current) return;
      parameterIds.current = new Set(next.parameters.map((p) => p.id));
      ruleAssetId.current = next.rule?.asset_id ?? null;
      const serverMs = Date.parse(next.server_time);
      if (Number.isFinite(serverMs)) {
        const offset = serverMs - Date.now();
        if (offsetRef.current === null || Math.abs(offset - offsetRef.current) > 1500) offsetRef.current = offset;
      }
      setDetail((prev) => mergeDetail(prev, next));
      setError("");
      setLastSync(Date.now());
    } catch (e) {
      if (mine === loadSeq.current) setError(e.message || "Could not load the rule status.");
    }
  }, [ruleId]);

  useEffect(() => {
    load();
    const schedule = createLiveUpdateScheduler(load, 250);
    const unsubscribe = subscribeLiveUpdates((update) => {
      if (update.type === "disconnected") { setConnected(false); return; }
      if (update.type === "connected" || update.type === "reconnected") { setConnected(true); schedule(); return; }
      if (update.type !== "database_change") return;
      const tables = update.changed_tables || [];
      if (!tables.some((t) => RELEVANT_TABLES.has(t))) return;
      const ids = update.entity_ids || {};
      // Users limited to some assets get no row identifiers, only the asset the change belongs to.
      const byAsset = Object.keys(ids).length === 0 && ruleAssetId.current !== null
        && (update.asset_ids || []).includes(ruleAssetId.current);
      const mine = update.resync_required || byAsset
        || (ids.nem_rule_states || []).includes(ruleId) || (ids.nem_alerts || []).includes(ruleId)
        || (ids.nem_monitoring_rules || []).includes(ruleId)
        || (ids.nem_rule_parameter_states || []).some((id) => parameterIds.current.has(id))
        || (ids.nem_rule_parameters || []).includes(ruleId);
      if (mine) schedule();
    });
    const poll = window.setInterval(schedule, FALLBACK_POLL_MS);
    // A tab returning from the background re-syncs immediately instead of waiting for the next update.
    const onVisible = () => { if (document.visibilityState === "visible") schedule(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { unsubscribe(); schedule.dispose(); window.clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [ruleId, load]);

  // The parent can ask for an immediate refetch (for example after one parameter was edited).
  useEffect(() => { if (refreshToken) load(); }, [refreshToken, load]);

  // Manual reset of every eligible interval of this rule (the dialog names them first).
  const resetAllIntervals = async () => {
    if (resetState.busy) return;
    setResetState({ busy: true, message: "", error: "" });
    try {
      const result = await confirmAndResetProgress({ confirm, url: `/rules/${ruleId}/reset-progress`, ruleName: detail.rule.name });
      setResetState({ busy: false, message: result.cancelled ? "" : result.message, error: "" });
      if (!result.cancelled) await load();
    } catch (requestError) {
      setResetState({ busy: false, message: "", error: requestError?.message || "Could not reset the intervals." });
    }
  };

  const staleLimit = Math.max(90, ((detail?.rule.stale_after_seconds) || 300));
  const overall = detail?.overall;
  const intervalRule = detail?.rule.type === "interval_based";

  return (
    <div className="rsd-inline">
      <div className="rsd-dialog" role="region" aria-labelledby={`rsd-title-${ruleId}`}>
        <header className="rsd-top">
          <div className="rsd-top-main">
            <h3 id={`rsd-title-${ruleId}`}>{detail?.rule.name || "Rule status"}</h3>
            {detail && (
              <p className="rsd-meta">
                {LIFECYCLE_LABEL[detail.rule.lifecycle_status] || detail.rule.lifecycle_status}
                {detail.rule.lifecycle_status === "completed" && detail.rule.completed_at ? ` ${new Date(detail.rule.completed_at).toLocaleString()}` : ""}
                {detail.rule.component_identifier ? ` · Component ${detail.rule.component_identifier}` : ""}
                {" · "}{overall.parameter_count} parameter{overall.parameter_count === 1 ? "" : "s"}
                {" · "}<span className="rsd-message">{summaryMessage(detail)}</span>
              </p>
            )}
          </div>
          <div className="rsd-top-right">
            {detail && intervalRule && (user?.role === "Administrator" || user?.role === "Supervisor") && (
              <button type="button" className="btn-outline rsd-reset-all" disabled={resetState.busy || detail.rule.lifecycle_status !== "in_progress"}
                title={detail.rule.lifecycle_status !== "in_progress" ? "Activate the rule before resetting its intervals." : "Reset the progress of every eligible interval of this rule"}
                onClick={resetAllIntervals}>
                {resetState.busy ? "Resetting…" : "Reset all intervals"}
              </button>
            )}
            {detail && <span className={`rsd-chip big is-${overall.status}`}>{overallWord(overall, intervalRule)}</span>}
            <LiveStatus connected={connected} lastSync={lastSync} staleLimit={staleLimit} />
          </div>
        </header>

        {error && <p className="rsd-error" role="alert">{error} {detail ? "Showing the last loaded data." : ""}</p>}
        {resetState.error && <p className="rsd-error" role="alert">{resetState.error}</p>}
        {resetState.message && <p className="rsd-note" role="status">{resetState.message}</p>}
        {!detail && !error && <p className="rsd-note rsd-loading" role="status">Loading rule status…</p>}

        {detail && (
          <div className="rsd-scroll">
            <div className="rsd-grid">
              {detail.parameters.map((p) => (
                <ParameterCard key={p.id} p={p} rule={detail.rule} ruleId={ruleId}
                  determining={overall.evaluating && overall.determined_by.includes(p.id) && p.status !== "normal"}
                  getOffsetMs={getOffsetMs}
                  onEdit={onEditParameter} onChanged={load} onOpenSchedule={openParameterSchedule} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
