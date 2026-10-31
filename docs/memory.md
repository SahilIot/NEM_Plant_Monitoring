# Implementation memory

This file records verified implementation decisions, important constraints,
and items where repository documentation and code disagree. It is not a
roadmap.

## Decisions and constraints

- PostgreSQL using `postgresql+psycopg` is the configured application database.
  `Settings` rejects other configured database URL schemes.
- Python application timestamps are aware UTC. The SQLAlchemy `UTCDateTime`
  adapter stores UTC-naive timestamps and returns aware UTC timestamps.
  Naive OPC UA timestamps are explicitly interpreted as UTC.
- Keep the out-of-order OPC UA guard. A notification older than the last
  accepted cycle/running signal is rejected. Legacy shifted timestamps must be
  investigated and repaired deliberately; a blind timezone offset is unsafe.
- The PLC integration is read-only. No application endpoint or collector
  method writes PLC values. The configured development OPC UA client currently
  omits transport encryption/certificate validation; this is a deployment
  limitation, not an accepted production security configuration.
- Machine cycle/runtime state and rule-specific counters are persisted. Rule
  counters are isolated per rule and asset so a new rule does not reset or
  inherit another rule's counter.
- Database initialization creates missing SQLAlchemy tables and applies
  additive startup updates in code. The repository instructions advise backup
  before schema changes. Existing database files in the workspace are not
  proof of the active deployment database or schema.
- Demo data created by `Nem_Backend/seed.py` is explicitly marked as simulated
  and must not be interpreted as live equipment telemetry.

## Current discrepancies and verification items

1. **Access scope needs verification.** `Nem_Backend/README.md` says
   non-Administrator asset operations are restricted to assigned machine IDs
   and WebSockets recheck machine access. In the inspected implementation,
   `db/session.py:get_db` attaches the user ID but does not apply an asset
   filter; standard asset/reading list routes do not show assignment filtering;
   and `main.py` calls `serve_live_updates` with
   `authorized_asset_ids=None`. WebSocket reauthorization checks that the
   session remains valid and the user active, but does not compute assigned
   asset IDs. Intended authorization scope and deployed behavior require
   confirmation. Do not treat the README's scope claim as verified.
2. **Root README is stale in places.** Its Safety and Limitations sections say
   the API has no authentication and that authentication/roles and
   email/SMS delivery are not implemented. Current source implements local
   bearer sessions and roles (`api/routes/auth.py`, `services/auth_security.py`)
   and an email outbox/delivery loop (`services/email_notifications.py`,
   `main.py`). The root README was reconciled with the implemented email
   behavior; production SMTP delivery still requires environment verification.
3. **Email behavior is conditional.** The outbox path is implemented, but
   delivery depends on the email feature setting, saved SMTP configuration,
   valid supervisor assignment/email addresses, and SMTP reachability. Pending
   jobs are revalidated at delivery time against the effective assignments:
   direct asset selections take precedence, with parent assignments inherited
   only when no direct selections exist. Removed or superseded recipients are
   skipped. Actual delivery still requires a safe SMTP verification.
4. **Maintenance recurrence is calendar-based.** The schema and service support
   days, weeks, months, and years plus confirm/decline of proposed dates.
   Running-hour/cycle-based maintenance scheduling is not implemented in the
   inspected code.
5. **Current terminology varies.** Current asset rule choices include “Cycle
   Clock” and “Motor Running Time”; some README text uses “Motor Rotation”.
   Preserve UI labels unless product owners confirm a terminology change.
6. **Test coverage is not established by this checkout.** `Nem_Backend` has no
   `tests/` directory or `*test*.py` source files in the inspected tree.
   `Nem_Frontend`'s `npm test` command is `node --test`; the prior interactive
   maintenance-fix session observed zero tests. A successful build from that
   session verified compilation, not runtime behavior or acceptance coverage.

## Recently corrected UI root cause

The Current status maintenance details modal passed `now={clockNow}` from
`features/assets/components/CurrentMaintenanceCards.jsx` without defining
`clockNow`. Opening **View maintenance** for an in-progress item raised
`ReferenceError`. The component now has a clock state and starts a one-second
timer only while the selected record is in progress; the timer is cleaned up
when the selection/status changes. The same value feeds
`MaintenanceDetails` for elapsed-duration display. The preceding session's
frontend production build succeeded after the correction.

## Verification still environment-dependent

- Confirm actual PostgreSQL schema/version and backup before applying
  startup-initialized schema updates.
- Confirm each deployed OPC UA NodeId, variable ownership/type, role mapping,
  source timestamps, quality, negotiated publishing interval, and PLC-approved
  network security.
- Exercise fresh/stale/reordered samples, false-to-true cycle edges, running
  timer pauses, alert acknowledgement/resolution, maintenance due alerts, and
  recurrence approvals against a controlled database and simulator.
- Confirm Administrator/Supervisor/Operator API permissions and asset
  assignment behavior, including WebSocket events, before deployment.
- Verify SMTP credentials, supervisor recipients, retries, and actual message
  delivery in a safe test environment.
