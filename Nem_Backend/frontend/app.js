const API = "/api/v1";
const state = {
  assets: [],
  summary: null,
  rules: [],
  statuses: [],
  activeAlerts: [],
  resolvedAlerts: [],
  events: [],
  maintenance: [],
  variablesByAsset: new Map(),
  selectedAsset: null,
  view: "overview",
  alertMode: "active",
  toastTimer: null,
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const formatDate = (value, options = { dateStyle: "medium" }) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, options).format(date);
};
const formatDateTime = (value) => formatDate(value, { dateStyle: "medium", timeStyle: "short" });
const assetName = (id) => state.assets.find((asset) => asset.id === id)?.name || `Asset ${id}`;
const variableName = (id) => {
  for (const variables of state.variablesByAsset.values()) {
    const variable = variables.find((item) => item.id === id);
    if (variable) return variable.name;
  }
  return `Signal ${id}`;
};
const safeCount = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "0";

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const detail = body?.detail ?? body?.error?.message ?? response.statusText;
    const message = Array.isArray(detail)
      ? detail.map((item) => item.msg || JSON.stringify(item)).join("; ")
      : typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(message || `Request failed (${response.status})`);
  }
  return body;
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3500);
}

function emptyState(message, icon = "✓") {
  return `<div class="empty-state"><span class="empty-mark">${icon}</span><span>${escapeHtml(message)}</span></div>`;
}

function statusForAsset(assetId) {
  if (!state.assets.find((asset) => asset.id === assetId)?.is_active) return "inactive";
  const statuses = state.statuses.filter((item) => item.target_asset_id === assetId);
  if (statuses.some((item) => item.status === "alert")) return "alert";
  if (statuses.some((item) => item.status === "warning")) return "warning";
  if (!statuses.length || statuses.some((item) => item.status === "unknown")) return "unknown";
  return "normal";
}

function statusLabel(status) {
  return ({ normal: "Normal", warning: "Warning", alert: "Alert", unknown: "Unknown", inactive: "Inactive" })[status] || status;
}

function renderAssetRows(assets, maxRows = Infinity) {
  if (!assets.length) return `<div class="empty-table">No assets yet. Add equipment to start monitoring.</div>`;
  const parentNames = new Map(state.assets.map((asset) => [asset.id, asset.name]));
  const rows = assets.slice(0, maxRows).map((asset) => {
    const status = statusForAsset(asset.id);
    const alertCount = state.activeAlerts.filter((alert) => alert.target_asset_id === asset.id).length;
    return `<tr data-open-asset="${asset.id}">
      <td><span class="asset-name-cell"><span class="asset-symbol">▦</span><span>${escapeHtml(asset.name)}<small class="asset-kind">${escapeHtml(asset.asset_type)}${asset.is_demo ? " · demo" : ""}</small></span></span></td>
      <td>${escapeHtml(parentNames.get(asset.parent_asset_id) || "—")}</td>
      <td><span class="status-pill status-${status}">${statusLabel(status)}</span></td>
      <td>${alertCount ? `<span class="severity-pill severity-alert">${alertCount} active</span>` : "—"}</td>
      <td>${formatDate(asset.updated_at)}</td>
      <td><span class="text-button">Details →</span></td>
    </tr>`;
  }).join("");
  return `<table class="data-table"><thead><tr><th>ASSET</th><th>PARENT</th><th>STATUS</th><th>ALERTS</th><th>UPDATED</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAlertPreview(alerts) {
  if (!alerts.length) return emptyState("All clear. No active alerts.", "✓");
  return alerts.slice(0, 4).map((alert) => `<div class="alert-preview">
    <span class="alert-mark ${escapeHtml(alert.severity)}"></span>
    <div><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(assetName(alert.target_asset_id))} · ${formatDateTime(alert.started_at)}</small></div>
    <span class="severity-pill severity-${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span>
  </div>`).join("");
}

function upcomingMaintenance() {
  const now = Date.now();
  return state.maintenance
    .filter((record) => record.next_due_at && new Date(record.next_due_at).getTime() >= now)
    .sort((a, b) => new Date(a.next_due_at) - new Date(b.next_due_at));
}

function renderUpcoming(limit = 4) {
  const due = upcomingMaintenance().slice(0, limit);
  if (!due.length) return emptyState("No upcoming service dates recorded.", "◷");
  return due.map((record) => {
    const date = new Date(record.next_due_at);
    return `<div class="due-row">
      <span class="due-date"><strong>${date.getDate()}</strong><small>${date.toLocaleDateString(undefined, { month: "short" })}</small></span>
      <span class="due-copy"><strong>${escapeHtml(record.summary)}</strong><small>${escapeHtml(assetName(record.asset_id))} · ${formatDate(record.next_due_at, { year: "numeric", month: "short", day: "numeric" })}</small></span>
    </div>`;
  }).join("");
}

function renderEvents(events) {
  if (!events.length) return emptyState("No events have been recorded yet.", "·");
  return events.slice(0, 5).map((event) => `<div class="timeline-row">
    <strong>${escapeHtml(event.message)}</strong>
    <small>${escapeHtml(event.event_type.replaceAll("_", " "))} · ${formatDateTime(event.occurred_at)}</small>
  </div>`).join("");
}

function renderRuleRows() {
  $("#rules-total").textContent = `${state.rules.length} total`;
  if (!state.rules.length) {
    $("#rules-table").innerHTML = `<div class="empty-table">No rules configured. Create a threshold or duration rule to watch an asset signal.</div>`;
    return;
  }
  const rows = state.rules.map((rule) => {
    const status = state.statuses.find((item) => item.rule_id === rule.id);
    const condition = rule.rule_type === "parameter_threshold"
      ? `${escapeHtml(rule.operator || "")} ${escapeHtml(rule.threshold ?? "")}`
      : `${escapeHtml(rule.parameters?.expected_value ?? "condition")} · ${safeCount(rule.parameters?.duration_seconds)} sec`;
    return `<tr>
      <td><strong>${escapeHtml(rule.name)}</strong><small class="asset-kind">${escapeHtml(rule.description || "")}</small></td>
      <td>${escapeHtml(assetName(rule.target_asset_id))}</td>
      <td>${escapeHtml(variableName(rule.variable_id))}<small class="asset-kind">${condition}</small></td>
      <td><span class="severity-pill severity-${escapeHtml(rule.severity)}">${escapeHtml(rule.severity)}</span></td>
      <td><span class="status-pill status-${escapeHtml(status?.status || "unknown")}">${statusLabel(status?.status || "unknown")}</span></td>
      <td><button class="toggle-button ${rule.is_enabled ? "is-on" : ""}" data-toggle-rule="${rule.id}" data-enabled="${rule.is_enabled}">${rule.is_enabled ? "Enabled" : "Disabled"}</button></td>
    </tr>`;
  }).join("");
  $("#rules-table").innerHTML = `<table class="data-table"><thead><tr><th>RULE</th><th>ASSET</th><th>CONDITION</th><th>SEVERITY</th><th>STATE</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAlerts() {
  const alerts = state.alertMode === "active" ? state.activeAlerts : state.resolvedAlerts;
  $("#active-alert-tab-count").textContent = safeCount(state.activeAlerts.length);
  $$(".segment").forEach((button) => button.classList.toggle("is-selected", button.dataset.alertMode === state.alertMode));
  if (!alerts.length) {
    $("#alerts-list").innerHTML = emptyState(
      state.alertMode === "active" ? "No active alerts. Your monitored conditions are clear." : "No resolved alert history yet.",
      state.alertMode === "active" ? "✓" : "·",
    );
    return;
  }
  $("#alerts-list").innerHTML = alerts.map((alert) => {
    const active = alert.status === "active";
    return `<article class="alert-card ${alert.severity === "alert" ? "severe" : ""}">
      <div class="alert-card-top"><div><h3>${escapeHtml(alert.title)}</h3><p>${escapeHtml(alert.message)}</p></div><span class="severity-pill severity-${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span></div>
      <div class="alert-meta"><span>Asset · ${escapeHtml(assetName(alert.target_asset_id))}</span><span>Value · ${escapeHtml(alert.trigger_value ?? "—")}</span><span>Started · ${formatDateTime(alert.started_at)}</span><span>${alert.acknowledged_at ? `Acknowledged by ${escapeHtml(alert.acknowledged_by || "operator")}` : "Unacknowledged"}</span></div>
      ${active ? `<div class="alert-card-actions"><button class="button button-secondary button-small" data-ack-alert="${alert.id}" ${alert.acknowledged_at ? "disabled" : ""}>${alert.acknowledged_at ? "Acknowledged" : "Acknowledge"}</button><button class="button button-secondary button-small" data-log-alert="${alert.id}">Log maintenance</button></div>` : `<div class="alert-meta">Resolved · ${formatDateTime(alert.resolved_at)}</div>`}
    </article>`;
  }).join("");
}

function renderMaintenance() {
  const upcoming = upcomingMaintenance();
  const overdue = state.maintenance.filter((record) => record.next_due_at && new Date(record.next_due_at).getTime() < Date.now());
  $("#metric-maintenance").textContent = safeCount(upcoming.length);
  $("#maintenance-total").textContent = `${state.maintenance.length} records`;
  $("#maintenance-summary").innerHTML = `<span class="stat-icon icon-green">◷</span><div><strong>${safeCount(upcoming.length)} upcoming · ${safeCount(overdue.length)} overdue</strong><p>Dates are based on the next due date entered in each service record.</p></div><button class="button button-secondary button-small" data-action="new-maintenance">＋ Log service</button>`;
  if (!state.maintenance.length) {
    $("#maintenance-table").innerHTML = `<div class="empty-table">No service work logged yet. Add a maintenance record after completing work.</div>`;
    return;
  }
  const rows = state.maintenance.map((record) => `<tr>
    <td><strong>${escapeHtml(record.summary)}</strong><small class="asset-kind">${escapeHtml(record.notes || "")}</small></td>
    <td>${escapeHtml(assetName(record.asset_id))}</td>
    <td>${escapeHtml(record.performed_by)}</td>
    <td>${formatDateTime(record.performed_at)}</td>
    <td>${record.next_due_at ? formatDate(record.next_due_at, { year: "numeric", month: "short", day: "numeric" }) : "Not scheduled"}</td>
    <td>${record.alert_id ? `<button class="text-button" data-alert-reference="${record.alert_id}">Alert #${record.alert_id}</button>` : "—"}</td>
  </tr>`).join("");
  $("#maintenance-table").innerHTML = `<table class="data-table"><thead><tr><th>WORK COMPLETED</th><th>ASSET</th><th>PERFORMED BY</th><th>COMPLETED AT</th><th>NEXT DUE</th><th>LINK</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderOverview() {
  const summary = state.summary || {};
  $("#metric-assets").textContent = safeCount(summary.total_assets);
  $("#metric-normal").textContent = safeCount(summary.rules_normal);
  $("#metric-alerts").textContent = safeCount(summary.total_active_alerts);
  $("#nav-asset-count").textContent = safeCount(summary.total_assets);
  $("#nav-alert-count").textContent = safeCount(summary.total_active_alerts);
  $("#overview-assets").innerHTML = renderAssetRows(state.assets, 6);
  $("#overview-alerts").innerHTML = renderAlertPreview(state.activeAlerts);
  $("#overview-due").innerHTML = renderUpcoming(4);
  $("#overview-events").innerHTML = renderEvents(state.events);
  renderMaintenance();
}

async function refreshAll({ quiet = false } = {}) {
  try {
    const [summary, assetPage, rulePage, monitoringPage, activePage, resolvedPage, eventPage, maintenancePage] = await Promise.all([
      api("/dashboard/summary"),
      api("/assets?limit=200"),
      api("/rules?limit=200"),
      api("/monitoring/status?limit=500"),
      api("/alerts/active?limit=200"),
      api("/alerts?lifecycle_status=resolved&limit=100"),
      api("/events?limit=10"),
      api("/maintenance?limit=200"),
    ]);
    const ruleVariableIds = [...new Set((rulePage.items || []).map((rule) => rule.variable_id).filter(Boolean))];
    const ruleVariables = await Promise.all(
      ruleVariableIds.map((variableId) => api(`/variables/${variableId}`)),
    );
    state.summary = summary;
    state.assets = assetPage.items || [];
    state.rules = rulePage.items || [];
    state.variablesByAsset = new Map();
    for (const variable of ruleVariables) {
      const variables = state.variablesByAsset.get(variable.asset_id) || [];
      variables.push(variable);
      state.variablesByAsset.set(variable.asset_id, variables);
    }
    state.statuses = monitoringPage.items || [];
    state.activeAlerts = activePage.items || [];
    state.resolvedAlerts = resolvedPage.items || [];
    state.events = eventPage.items || [];
    state.maintenance = maintenancePage.items || [];
    await refreshPlcAssetOptions();
    $("#connection-state").textContent = "API connected";
    $("#connection-dot").classList.add("is-online");
    $("#updated-label").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    renderOverview();
    renderAssetTable();
    renderRuleRows();
    renderAlerts();
    if ($("#maintenance-table")) renderMaintenance();
    if (state.selectedAsset && $("#asset-detail-dialog").open) await openAssetDetails(state.selectedAsset.id, false);
    if (!quiet) showToast("Monitoring data refreshed");
  } catch (error) {
    $("#connection-state").textContent = "API unavailable";
    $("#connection-dot").classList.remove("is-online");
    $("#updated-label").textContent = "Could not refresh";
    if (!quiet) showToast(error.message, true);
    throw error;
  }
}

function renderAssetTable() {
  const container = $("#assets-table");
  if (!container) return;
  const search = ($("#asset-search")?.value || "").trim().toLowerCase();
  const filter = $("#asset-status-filter")?.value || "";
  const filtered = state.assets.filter((asset) => {
    const matchesSearch = `${asset.name} ${asset.asset_type}`.toLowerCase().includes(search);
    const matchesStatus = !filter || (filter === "active" ? asset.is_active : !asset.is_active);
    return matchesSearch && matchesStatus;
  });
  container.innerHTML = renderAssetRows(filtered);
}

function setView(view) {
  state.view = view;
  $$(".view").forEach((section) => section.classList.toggle("is-visible", section.id === `view-${view}`));
  $$(".nav-link").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("#crumb-current").textContent = ({ overview: "Overview", assets: "Assets", rules: "Rules", alerts: "Alerts", maintenance: "Maintenance", plc: "PLC / OPC UA" })[view] || "Overview";
  if (view === "alerts") renderAlerts();
}

function setPlcConnection(connected, tested = true) {
  const badge = $("#plc-connection-badge");
  badge.classList.toggle("is-online", connected);
  badge.classList.toggle("is-error", !connected && tested);
  badge.lastElementChild.textContent = connected ? "Connected" : tested ? "Connection failed" : "Not tested";
}

function setPlcResult(element, message, kind = "") {
  element.classList.toggle("is-success", kind === "success");
  element.classList.toggle("is-error", kind === "error");
  element.textContent = message;
}

async function refreshPlcAssetOptions() {
  const select = $("#plc-asset");
  const current = Number(select.value);
  const currentVariable = Number($("#plc-variable").value);
  const assets = state.assets.filter((asset) => asset.is_active);
  select.innerHTML = assets.length
    ? assets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)} · ${escapeHtml(asset.asset_type)}</option>`).join("")
    : `<option value="">No active assets</option>`;
  if (!assets.length) {
    $("#plc-variable").innerHTML = `<option value="">No active variables</option>`;
    return;
  }
  select.value = assets.some((asset) => asset.id === current) ? String(current) : String(assets[0].id);
  await loadVariables(select.value, $("#plc-variable"), Number.isInteger(currentVariable) && currentVariable > 0 ? currentVariable : null);
}

async function testPlcConnection(button) {
  const result = $("#plc-test-result");
  button.disabled = true;
  button.textContent = "Testing…";
  setPlcResult(result, "Checking the secure OPC UA connection and reading the server time node…");
  setPlcConnection(false, false);
  try {
    const response = await api("/plc/test");
    setPlcConnection(true);
    setPlcResult(result, `Secure connection succeeded. Server time: ${response.server_time || "available"}. ${response.message || ""}`, "success");
  } catch (error) {
    setPlcConnection(false);
    setPlcResult(result, error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Test secure connection";
  }
}

async function readPlcValue(form, button) {
  const data = new FormData(form);
  const result = $("#plc-read-result");
  button.disabled = true;
  button.textContent = "Reading…";
  setPlcResult(result, "Reading the selected NodeId once…");
  let ingested = false;
  try {
    const response = await api("/plc/read", {
      method: "POST",
      body: JSON.stringify({
        node_id: formValue(data, "node_id"),
        asset_id: Number(data.get("asset_id")),
        variable_id: Number(data.get("variable_id")),
        source_id: formValue(data, "source_id") || "opcua",
      }),
    });
    const reading = response.reading || {};
    const readingTime = reading.recorded_at ? formatDateTime(reading.recorded_at) : "time unavailable";
    ingested = true;
    setPlcResult(result, `Read and ingested successfully. Value: ${JSON.stringify(response.value)} · ${readingTime}. Matching monitoring rules were evaluated.`, "success");
    await refreshAll({ quiet: true });
  } catch (error) {
    if (ingested) showToast(`PLC reading was saved, but dashboard refresh failed: ${error.message}`, true);
    else setPlcResult(result, error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Read node and ingest";
  }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else dialog?.removeAttribute("open");
}

function fillAssetSelect(select, { includeBlank = false, selected = null } = {}) {
  const options = state.assets.map((asset) => `<option value="${asset.id}" ${asset.id === selected ? "selected" : ""}>${escapeHtml(asset.name)} · ${escapeHtml(asset.asset_type)}</option>`).join("");
  select.innerHTML = `${includeBlank ? `<option value="">Select asset</option>` : ""}${options}`;
}

async function loadVariables(assetId, select, selected = null) {
  const page = await api(`/assets/${assetId}/variables?limit=200`);
  const variables = (page.items || []).filter((item) => item.is_active);
  state.variablesByAsset.set(Number(assetId), variables);
  select.innerHTML = variables.length
    ? variables.map((variable) => `<option value="${variable.id}" ${variable.id === selected ? "selected" : ""}>${escapeHtml(variable.name)} · ${escapeHtml(variable.data_type)}${variable.unit ? ` (${escapeHtml(variable.unit)})` : ""}</option>`).join("")
    : `<option value="">No active variables</option>`;
}

function openAssetDialog() {
  const form = $("#asset-form");
  form.reset();
  $("#asset-parent").innerHTML = `<option value="">Root asset</option>${state.assets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join("")}`;
  openDialog("asset-dialog");
}

async function openRuleDialog(assetId = null, variableId = null) {
  if (!state.assets.length) {
    showToast("Add an asset before creating a rule", true);
    return;
  }
  const form = $("#rule-form");
  form.reset();
  fillAssetSelect($("#rule-asset"), { selected: assetId || state.assets[0].id });
  await loadVariables($("#rule-asset").value, $("#rule-variable"), variableId);
  updateRuleFields();
  openDialog("rule-dialog");
}

function updateRuleFields() {
  const isDuration = $("#rule-type").value === "duration";
  $("#threshold-fields").classList.toggle("is-hidden", isDuration);
  $("#duration-fields").classList.toggle("is-hidden", !isDuration);
  $("#rule-form").elements.threshold.required = !isDuration;
  $("#rule-form").elements.duration_seconds.required = isDuration;
  $("#rule-form").elements.expected_value.required = isDuration;
}

function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function openMaintenanceDialog(assetId = null, alertId = null) {
  if (!state.assets.length) {
    showToast("Add an asset before logging maintenance", true);
    return;
  }
  const form = $("#maintenance-form");
  form.reset();
  fillAssetSelect($("#maintenance-asset"), { selected: assetId || state.assets[0].id });
  $("#maintenance-form").elements.performed_at.value = localDateTimeValue();
  await updateMaintenanceAlerts(alertId);
  openDialog("maintenance-dialog");
}

async function updateMaintenanceAlerts(selected = null) {
  const assetId = Number($("#maintenance-asset").value);
  const alertSelect = $("#maintenance-alert");
  const alerts = await api(`/alerts/active?asset_id=${assetId}&limit=200`);
  alertSelect.innerHTML = `<option value="">No linked alert</option>${(alerts.items || []).map((alert) => `<option value="${alert.id}" ${alert.id === Number(selected) ? "selected" : ""}>${escapeHtml(alert.title)} · ${escapeHtml(alert.severity)}</option>`).join("")}`;
}

async function openAssetDetails(assetId, show = true) {
  const asset = state.assets.find((item) => item.id === Number(assetId));
  if (!asset) return;
  state.selectedAsset = asset;
  $("#detail-title").textContent = asset.name;
  $("#detail-subtitle").textContent = `${asset.asset_type}${asset.parent_asset_id ? ` · Child of ${assetName(asset.parent_asset_id)}` : " · Root asset"}`;
  $("#asset-detail-content").innerHTML = `<div class="empty-state">Loading asset signals…</div>`;
  if (show) openDialog("asset-detail-dialog");
  const [variablesPage, readings, statusPage, alertsPage, maintenancePage] = await Promise.all([
    api(`/assets/${asset.id}/variables?limit=200`),
    api(`/readings/assets/${asset.id}/latest`),
    api(`/assets/${asset.id}/monitoring-status?limit=200`),
    api(`/alerts/active?asset_id=${asset.id}&limit=100`),
    api(`/maintenance?asset_id=${asset.id}&limit=20`),
  ]);
  const variables = variablesPage.items || [];
  state.variablesByAsset.set(asset.id, variables);
  const readingByVariable = new Map(readings.map((reading) => [reading.variable_id, reading]));
  const assetStatuses = statusPage.items || [];
  const alerts = alertsPage.items || [];
  const logs = maintenancePage.items || [];
  const rows = variables.map((variable) => {
    const reading = readingByVariable.get(variable.id);
    const ruleState = assetStatuses.find((item) => item.target_variable_id === variable.id);
    return `<tr><td><strong>${escapeHtml(variable.name)}</strong><small class="asset-kind">${escapeHtml(variable.key)}</small></td><td>${escapeHtml(reading?.value ?? "No reading")}${variable.unit ? ` ${escapeHtml(variable.unit)}` : ""}</td><td>${formatDateTime(reading?.recorded_at)}</td><td><span class="status-pill status-${escapeHtml(ruleState?.status || "unknown")}">${statusLabel(ruleState?.status || "unknown")}</span></td></tr>`;
  }).join("");
  const alertContent = alerts.length ? alerts.map((alert) => `<div class="alert-preview"><span class="alert-mark ${escapeHtml(alert.severity)}"></span><div><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.message)}</small></div><span class="severity-pill severity-${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span></div>`).join("") : emptyState("No active alerts for this asset.");
  const logRows = logs.slice(0, 5).map((record) => `<tr><td>${escapeHtml(record.summary)}</td><td>${escapeHtml(record.performed_by)}</td><td>${formatDate(record.performed_at)}</td><td>${record.next_due_at ? formatDate(record.next_due_at) : "—"}</td></tr>`).join("");
  $("#asset-detail-content").innerHTML = `
    <div class="detail-metrics">
      <div class="detail-metric"><span>Signals</span><strong>${safeCount(variables.length)}</strong></div>
      <div class="detail-metric"><span>Active alerts</span><strong>${safeCount(alerts.length)}</strong></div>
      <div class="detail-metric"><span>Asset status</span><strong>${statusLabel(statusForAsset(asset.id))}</strong></div>
    </div>
    <section class="detail-section"><h3>Signals and latest readings</h3>${variables.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>VARIABLE</th><th>LATEST VALUE</th><th>RECORDED</th><th>RULE STATE</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("Add variables to this asset to start receiving readings.")}</section>
    <section class="detail-section"><h3>Active alerts</h3>${alertContent}</section>
    <section class="detail-section"><h3>Recent maintenance</h3>${logs.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>WORK</th><th>PERFORMED BY</th><th>COMPLETED</th><th>NEXT DUE</th></tr></thead><tbody>${logRows}</tbody></table></div>` : emptyState("No maintenance logged for this asset.")}</section>`;
}

async function submitForm(form, callback) {
  const submitButton = $("button[type='submit']", form);
  submitButton.disabled = true;
  try {
    await callback(new FormData(form));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
}

function formValue(data, name) {
  const value = String(data.get(name) ?? "").trim();
  return value || null;
}

async function createAsset(data) {
  const parentId = formValue(data, "parent_asset_id");
  await api("/assets", {
    method: "POST",
    body: JSON.stringify({
      name: formValue(data, "name"),
      asset_type: formValue(data, "asset_type"),
      description: formValue(data, "description"),
      parent_asset_id: parentId ? Number(parentId) : null,
    }),
  });
  closeDialog("asset-dialog");
  await refreshAll({ quiet: true });
  showToast("Asset added");
}

async function createVariable(data) {
  const assetId = Number(data.get("asset_id"));
  await api(`/assets/${assetId}/variables`, {
    method: "POST",
    body: JSON.stringify({
      name: formValue(data, "name"),
      key: formValue(data, "key"),
      data_type: data.get("data_type"),
      unit: formValue(data, "unit"),
    }),
  });
  closeDialog("variable-dialog");
  await refreshAll({ quiet: true });
  await openAssetDetails(assetId, false);
  showToast("Variable added");
}

async function createRule(data) {
  const assetId = Number(data.get("target_asset_id"));
  const variable = (state.variablesByAsset.get(assetId) || []).find((item) => item.id === Number(data.get("variable_id")));
  if (!variable) throw new Error("Choose an active variable for this rule");
  const ruleType = data.get("rule_type");
  const payload = {
    name: formValue(data, "name"),
    description: formValue(data, "description"),
    rule_type: ruleType,
    target_asset_id: assetId,
    variable_id: variable.id,
    severity: data.get("severity"),
  };
  const staleAfter = formValue(data, "stale_after_seconds");
  if (staleAfter) payload.stale_after_seconds = Number(staleAfter);
  if (ruleType === "parameter_threshold") {
    payload.operator = data.get("operator");
    payload.threshold = Number(data.get("threshold"));
    if (!Number.isFinite(payload.threshold)) throw new Error("Enter a valid numeric threshold");
  } else {
    const duration = Number(data.get("duration_seconds"));
    if (!Number.isInteger(duration) || duration <= 0) throw new Error("Duration must be a positive whole number of seconds");
    const rawExpected = formValue(data, "expected_value");
    if (rawExpected === null) throw new Error("Enter the signal value that starts the duration timer");
    let expectedValue = rawExpected;
    if (variable.data_type === "integer") {
      expectedValue = Number(rawExpected);
      if (!Number.isInteger(expectedValue)) throw new Error("Expected value must be a whole number for this signal");
    } else if (variable.data_type === "number") {
      expectedValue = Number(rawExpected);
      if (!Number.isFinite(expectedValue)) throw new Error("Expected value must be numeric for this signal");
    } else if (variable.data_type === "boolean") {
      if (!["true", "false"].includes(rawExpected.toLowerCase())) throw new Error("For a boolean signal, enter true or false");
      expectedValue = rawExpected.toLowerCase() === "true";
    }
    payload.parameters = { condition: "equals", expected_value: expectedValue, duration_seconds: duration };
  }
  await api("/rules", { method: "POST", body: JSON.stringify(payload) });
  closeDialog("rule-dialog");
  await refreshAll({ quiet: true });
  showToast("Monitoring rule created");
}

async function createMaintenance(data) {
  const performedLocal = formValue(data, "performed_at");
  const nextLocal = formValue(data, "next_due_at");
  const payload = {
    asset_id: Number(data.get("asset_id")),
    alert_id: formValue(data, "alert_id") ? Number(data.get("alert_id")) : null,
    summary: formValue(data, "summary"),
    notes: formValue(data, "notes"),
    performed_by: formValue(data, "performed_by"),
    performed_at: performedLocal ? new Date(performedLocal).toISOString() : null,
    next_due_at: nextLocal ? new Date(nextLocal).toISOString() : null,
  };
  if (payload.next_due_at && new Date(payload.next_due_at) <= new Date(payload.performed_at)) {
    throw new Error("Next due date must be after the maintenance completion date");
  }
  await api("/maintenance", { method: "POST", body: JSON.stringify(payload) });
  closeDialog("maintenance-dialog");
  await refreshAll({ quiet: true });
  showToast("Maintenance record saved");
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, tr, a");
  if (!target) return;
  try {
    if (target.dataset.view) return setView(target.dataset.view);
    if (target.dataset.navigate) return setView(target.dataset.navigate);
    if (target.dataset.close) return closeDialog(target.dataset.close);
    if (target.dataset.action === "new-asset") return openAssetDialog();
    if (target.dataset.action === "new-rule") return await openRuleDialog();
    if (target.dataset.action === "new-maintenance") return await openMaintenanceDialog();
    if (target.dataset.action === "plc-test") return await testPlcConnection(target);
    if (target.dataset.action === "evaluate") {
      await api("/monitoring/evaluate", { method: "POST" });
      await refreshAll({ quiet: true });
      return showToast("Enabled rules evaluated");
    }
    if (target.dataset.openAsset) return await openAssetDetails(Number(target.dataset.openAsset));
    if (target.dataset.ackAlert) {
      await api(`/alerts/${target.dataset.ackAlert}/acknowledge`, { method: "POST", body: JSON.stringify({}) });
      await refreshAll({ quiet: true });
      return showToast("Alert acknowledged");
    }
    if (target.dataset.logAlert) {
      const alert = state.activeAlerts.find((item) => item.id === Number(target.dataset.logAlert));
      return await openMaintenanceDialog(alert?.target_asset_id, alert?.id);
    }
    if (target.dataset.toggleRule) {
      const enabled = target.dataset.enabled === "true";
      await api(`/rules/${target.dataset.toggleRule}`, {
        method: "PATCH",
        body: JSON.stringify({ is_enabled: !enabled }),
      });
      await refreshAll({ quiet: true });
      return showToast(enabled ? "Rule disabled" : "Rule enabled");
    }
    if (target.id === "refresh-button") return await refreshAll();
    if (target.id === "detail-add-variable" && state.selectedAsset) {
      const form = $("#variable-form");
      form.reset();
      form.elements.asset_id.value = state.selectedAsset.id;
      return openDialog("variable-dialog");
    }
    if (target.id === "detail-add-rule" && state.selectedAsset) return await openRuleDialog(state.selectedAsset.id);
    if (target.id === "detail-log-maintenance" && state.selectedAsset) return await openMaintenanceDialog(state.selectedAsset.id);
    if (target.dataset.alertMode) {
      state.alertMode = target.dataset.alertMode;
      return renderAlerts();
    }
    if (target.dataset.alertReference) {
      state.alertMode = "resolved";
      setView("alerts");
      renderAlerts();
      return;
    }
  } catch (error) {
    showToast(error.message, true);
  }
});

$("#asset-search").addEventListener("input", renderAssetTable);
$("#asset-status-filter").addEventListener("change", renderAssetTable);
$("#rule-type").addEventListener("change", updateRuleFields);
$("#rule-asset").addEventListener("change", async (event) => {
  try {
    await loadVariables(event.target.value, $("#rule-variable"));
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#maintenance-asset").addEventListener("change", async () => {
  try {
    await updateMaintenanceAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#plc-asset").addEventListener("change", async (event) => {
  try {
    await loadVariables(event.target.value, $("#plc-variable"));
  } catch (error) {
    $("#plc-variable").innerHTML = `<option value="">Could not load variables</option>`;
    setPlcResult($("#plc-read-result"), error.message, "error");
  }
});
$("#asset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, createAsset);
});
$("#variable-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, createVariable);
});
$("#rule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, createRule);
});
$("#maintenance-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, createMaintenance);
});
$("#plc-read-form").addEventListener("submit", (event) => {
  event.preventDefault();
  readPlcValue(event.currentTarget, $("#plc-read-button"));
});

setView("overview");
refreshAll({ quiet: true }).catch(() => {
  $("#overview-assets").innerHTML = emptyState("Start the FastAPI service to load monitoring data.", "!");
});
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshAll({ quiet: true }).catch(() => {});
}, 15_000);
