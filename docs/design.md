# Design and interaction

## Design principles present in the implementation

The UI is an operational dashboard rather than a marketing site. It prioritizes
machine status, active conditions, counts, timestamps, and direct task actions.
The current implementation uses shared layouts and controls; this document
describes those patterns and does not prescribe a redesign.

### Application shell

`Nem_Frontend/src/components/common/Layout.jsx` provides:

- A top bar with the NEM brand, page title, signed-in username and role, a
  backend connectivity indicator, sign-out, theme toggle, and Administrator
  user-access link.
- A collapsible navigation rail for **Overview**, **Assets**, **PLC / OPC UA**,
  **Configuration**, and **Settings**. It becomes a compact expandable rail on
  narrow viewports.
- Breadcrumbs and a scrollable content area. Asset pages have a separate asset
  tree panel with search and hierarchy controls.
- Persisted light/dark theme and rail preference in browser local storage.

`Nem_Frontend/src/app/App.jsx` defines routes. `src/app/main.jsx` mounts the
router at `/ui`, wraps it in `AuthProvider` and a React error boundary, and
loads `src/styles/global.css`.

### Navigation and pages

- **Overview** (`features/dashboard/pages/Home.jsx`): severity/count tiles,
  “Needs attention” active alerts, recent evaluated alerts, and live cycle and
  machine status summaries. Alert actions include acknowledge and complete.
- **Assets** (`features/assets/pages/AssetsIndex.jsx` and `AssetDetail.jsx`):
  selects an asset in the tree. Asset detail shows asset health and metadata,
  the **Current status**, **Maintenance logbook**, and **Event log** tabs,
  monitoring rules, current/due/completed maintenance, variables, and
  asset-specific controls. Filtering, sorting, child-asset inclusion, and rule
  lifecycle actions are available from the status view.
- **PLC / OPC UA** (`features/plc/pages/Plc.jsx`): recent saved PLC readings,
  connection status, mapping and publishing details, monitoring state,
  connection test, discovery, and one-shot read-and-save controls. The page
  explicitly warns that its development OPC UA connection is unencrypted.
- **Configuration** (`features/configuration/pages/`): rule library and
  collections, instruction/document creation and viewing, import/export, and
  related configuration workflows.
- **Settings** (`features/settings/pages/`): profile, email server, usage,
  backup/restore, and other settings subsections. **User access** is routed to
  `features/auth/AdminUsersPage.jsx`.
- **Monitoring rule pages** are implemented under `features/rules/pages/` and
  `features/assets/pages/`; asset-specific creation is linked from Current
  status. Reusable templates are managed in the rule library.
- **Maintenance forms** and occurrence/schedule UI are in
  `features/assets/components/MaintenancePanel.jsx` and
  `features/assets/pages/CreateMaintenanceSchedulePage.jsx`.

### Visual language

`src/styles/global.css` defines CSS variables used throughout the product.
The light theme uses a pale gray page background, white panels, dark text, a
NEM red brand accent, and blue action controls. Status colors distinguish
normal/healthy (green), warning (amber), alert (red), and inactive/off (gray).
`[data-theme="dark"]` overrides the same tokens for dark surfaces and readable
status colors. Typography uses Barlow/Bahnschrift/Segoe UI fallbacks. Controls
have compact fixed-height sizing, lightly rounded panels, and visible keyboard
focus outlines.

Shared UI in `components/common/UI.jsx` includes `EmptyState`, `StatusBadge`,
`Modal`, `FloatingMenu`, `CreateModal`, and `ConfirmationProvider`. Confirmation
dialogs are used for consequential and destructive actions. Floating action
menus are rendered in a portal and positioned to remain in the viewport.

## Interaction requirements evident in current code

- Keep live refreshes from overwriting form input. Asset/configuration views
  refresh data in place, avoid overlapping requests in key polling paths, and
  dispose timers/subscriptions when components unmount.
- Show loading, empty, success, and error states close to the affected content;
  do not replace errors with success-shaped values.
- Give disabled actions a reason through helper text/title where available;
  destructive deletion requires confirmation, and some permanent deletes
  require a second confirmation.
- Preserve navigation context when moving from alerts/rules to an asset and
  back. `utils/navigation.js` stores and restores route-origin state.
- Use status words and visual badges together; a color/lamp is not the only
  indication. Status text includes concepts such as `Unknown`/`Not evaluated`,
  `Warning`, `Alert`, and `In progress`.
- Expose accessible names, tab roles, dialog roles, live status/error roles,
  and keyboard focus indicators. Menus close on outside pointer/Escape in the
  affected components; dialogs close on Escape or backdrop unless the caller
  prevents it.
- Running duration is derived from backend timestamps and refreshed locally
  while active. Live machine counters are backend-owned; the frontend does not
  increment cycle counts.
- The shared API client adds the bearer token and turns HTTP failures into
  displayed errors. An expired session redirects to login.

## Existing interaction constraints

- The asset tree is a separate panel beside the content. The rail and tree have
  their own expand/collapse behavior; preserve this navigation model.
- Current status, the maintenance logbook, and event history are separate asset
  tabs. Maintenance schedule management is not the monitoring rule editor.
- Some asset and configuration actions are role-gated in both the UI and API.
  The backend remains authoritative; hiding or disabling a control is not a
  substitute for API authorization.
- Data refresh is mixed: the WebSocket notifies the client about committed
  changes, while selected dashboard/PLC/asset data also refreshes on timers.
  Do not assume every page updates solely from WebSocket messages.
- Existing theme, responsive breakpoints, terminology, dialogs, confirmation
  flow, and operational data density are constraints for future UI changes.

No separate design-system specification, accessibility conformance report,
browser support matrix, or user research artifact was found in the repository.

