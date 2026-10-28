#Email notifications for warnings and alerts, delivered from a persistent outbox.

#Alert creation only enqueues rows (same transaction, never raises). A background
#loop delivers them using the SMTP settings saved by an Administrator, so SMTP
#failures can never block or lose an alert.
import logging
import re
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any
from zoneinfo import ZoneInfo

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.models import (
    Alert,
    Asset,
    AssetSupervisor,
    EmailNotification,
    FrontendConfig,
    MonitoringRule,
    User,
)

LOGGER = logging.getLogger("nem_backend.notifications")
_EMAIL_REGEX = re.compile(r"^[^\s@<>\",;]+@[^\s@<>\",;]+\.[^\s@<>\",;]+$")
_RETRY_BASE_SECONDS = 60
_RETRY_MAX_SECONDS = 3600


def _now() -> datetime:
    return datetime.now(timezone.utc)


def valid_email(value: str | None) -> bool:
    return bool(value) and len(value) <= 254 and bool(_EMAIL_REGEX.match(value.strip()))


def supervisors_for_asset(session: Session, asset: Asset) -> list[User]:
    #Active Supervisors assigned to the asset or, failing that, its nearest assigned ancestor.
    current: Asset | None = asset
    visited: set[int] = set()
    while current is not None and current.id not in visited:
        visited.add(current.id)
        users = session.scalars(
            select(User)
            .join(AssetSupervisor, AssetSupervisor.user_id == User.id)
            .where(
                AssetSupervisor.asset_id == current.id,
                User.is_active.is_(True),
                User.role == "Supervisor",
            )
            .order_by(User.id)
        ).all()
        if users:
            return list(users)
        current = session.get(Asset, current.parent_asset_id) if current.parent_asset_id else None
    return []


def _location(session: Session, asset: Asset) -> str:
    names = [asset.name]
    parent_id = asset.parent_asset_id
    seen = {asset.id}
    while parent_id is not None and parent_id not in seen:
        seen.add(parent_id)
        parent = session.get(Asset, parent_id)
        if parent is None:
            break
        names.append(parent.name)
        parent_id = parent.parent_asset_id
    return " > ".join(reversed(names))


def enqueue_alert_notifications(
    session: Session,
    alert: Alert,
    asset: Asset,
    rule: MonitoringRule | None,
    settings: Settings | None = None,
) -> int:
    # Queue one email per responsible supervisor for this alert/severity. Never raises.
    try:
        with session.begin_nested():
            return _enqueue(session, alert, asset, rule, settings)
    except Exception:
        LOGGER.exception("Could not queue email notification for alert %s", alert.id)
        return 0


def _enqueue(session: Session, alert: Alert, asset: Asset, rule: MonitoringRule | None, settings: Settings | None) -> int:
    if settings is not None and not settings.email_notifications_enabled:
        return 0
    if alert.id is None:
        session.flush()
    supervisors = supervisors_for_asset(session, asset)
    if not supervisors:
        LOGGER.warning(
            "No supervisor assigned to asset %s (%s); %s email for alert %s not sent",
            asset.id, asset.name, alert.severity, alert.id,
        )
        return 0
    base_url = (settings.frontend_base_url if settings else "").rstrip("/")
    payload = {
        "asset_id": asset.id,
        "asset_name": asset.name,
        "location": _location(session, asset),
        "severity": alert.severity,
        "title": alert.title,
        "message": alert.message,
        "rule_name": rule.name if rule is not None else alert.title,
        "rule_type": rule.rule_type if rule is not None else "maintenance_due",
        "threshold": str(alert.threshold) if alert.threshold is not None else None,
        "observed_value": alert.trigger_value,
        "event_time": (alert.last_updated_at or alert.started_at or _now()).astimezone(timezone.utc).isoformat(),
        "status": alert.status,
        "link": f"{base_url}/assets/{asset.id}" if base_url else None,
    }
    queued = 0
    for user in supervisors:
        exists = session.scalar(
            select(EmailNotification.id).where(
                EmailNotification.alert_id == alert.id,
                EmailNotification.severity == alert.severity,
                EmailNotification.user_id == user.id,
            )
        )
        if exists is not None:
            continue
        if not valid_email(user.email_address):
            session.add(EmailNotification(
                alert_id=alert.id, user_id=user.id, severity=alert.severity, payload=payload,
                status="skipped", last_error="Supervisor has no valid email address",
            ))
            LOGGER.warning("Supervisor user %s has no valid email; skipping alert %s email", user.id, alert.id)
            continue
        session.add(EmailNotification(
            alert_id=alert.id, user_id=user.id, severity=alert.severity, payload=payload,
        ))
        queued += 1
    session.flush()
    return queued


class SmtpConfigError(RuntimeError):
    pass


def _load_smtp_config(session: Session, settings: Settings) -> dict[str, Any]:
    record = session.get(FrontendConfig, "email")
    value = dict(record.value) if record is not None else {}
    host = str(value.get("host") or "").strip()
    sender = str(value.get("sender") or "").strip()
    username = str(value.get("username") or "").strip()
    if not host:
        raise SmtpConfigError("SMTP host is not configured")
    from_address = sender or username
    if not valid_email(from_address):
        raise SmtpConfigError("Administrator sender address is missing or invalid")
    try:
        port = int(value.get("port") or 587)
    except (TypeError, ValueError) as error:
        raise SmtpConfigError("SMTP port is invalid") from error
    password = ""
    ciphertext = value.get("password_ciphertext")
    if ciphertext:
        key = settings.settings_encryption_key.get_secret_value().strip()
        if not key:
            raise SmtpConfigError("SETTINGS_ENCRYPTION_KEY is required to decrypt the SMTP password")
        try:
            password = Fernet(key.encode("ascii")).decrypt(str(ciphertext).encode("ascii")).decode()
        except (InvalidToken, ValueError):
            raise SmtpConfigError("Stored SMTP password could not be decrypted") from None
    return {"host": host, "port": port, "username": username, "password": password, "from_address": from_address}


def _format_time(iso_value: str, settings: Settings) -> str:
    moment = datetime.fromisoformat(iso_value)
    try:
        zone = ZoneInfo(settings.email_display_timezone)
    except Exception:
        zone = timezone.utc
    local = moment.astimezone(zone)
    return local.strftime("%Y-%m-%d %H:%M:%S ") + (local.tzname() or "UTC")


def _clean(value: Any) -> str:
    return re.sub(r"[\r\n]+", " ", str(value))


def build_message(payload: dict[str, Any], *, sender: str, recipient: str, settings: Settings) -> EmailMessage:
    kind = "Alert" if payload["severity"] == "alert" else "Warning"
    asset_name = _clean(payload["asset_name"])
    rows = [
        ("Event type", kind),
        ("Asset", f"{asset_name} (ID {payload['asset_id']})"),
        ("Location", _clean(payload.get("location") or asset_name)),
        ("Rule", _clean(payload.get("rule_name") or "")),
        ("Rule type", _clean(payload.get("rule_type") or "")),
        ("Threshold", _clean(payload["threshold"]) if payload.get("threshold") is not None else "n/a"),
        ("Observed value", _clean(payload["observed_value"]) if payload.get("observed_value") is not None else "n/a"),
        ("Event time", _format_time(payload["event_time"], settings)),
        ("Status", _clean(payload.get("status") or "active").capitalize()),
        ("Details", _clean(payload.get("message") or "")),
    ]
    if payload.get("link"):
        rows.append(("Link", payload["link"]))
    message = EmailMessage()
    message["Subject"] = f"[NEM Monitoring] {kind} – Asset: {asset_name}"
    message["From"] = formataddr(("NEM Plant Monitoring", sender))
    message["To"] = recipient
    text = "NEM Plant Monitoring – automated notification\n\n" + "\n".join(f"{k}: {v}" for k, v in rows)
    message.set_content(text + "\n\nThis message was generated automatically. Do not reply.\n")
    return message


def _send(config: dict[str, Any], message: EmailMessage, timeout: int) -> None:
    context = ssl.create_default_context()
    if config["port"] == 465:
        client: smtplib.SMTP = smtplib.SMTP_SSL(config["host"], config["port"], timeout=timeout, context=context)
    else:
        client = smtplib.SMTP(config["host"], config["port"], timeout=timeout)
    with client:
        client.ehlo()
        if config["port"] != 465 and client.has_extn("starttls"):
            client.starttls(context=context)
            client.ehlo()
        if config["username"] and config["password"]:
            client.login(config["username"], config["password"])
        client.send_message(message, from_addr=config["from_address"], to_addrs=[message["To"]])


def _describe_error(error: Exception) -> str:
    if isinstance(error, SmtpConfigError):
        return str(error)
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return "SMTP authentication failed (check username and password)"
    if isinstance(error, smtplib.SMTPRecipientsRefused):
        return "SMTP server rejected the recipient address"
    if isinstance(error, smtplib.SMTPSenderRefused):
        return "SMTP server rejected the sender address"
    if isinstance(error, (TimeoutError, smtplib.SMTPServerDisconnected)):
        return f"SMTP connection timed out or was closed ({type(error).__name__})"
    if isinstance(error, (OSError, smtplib.SMTPException)):
        return f"SMTP delivery error ({type(error).__name__})"
    return f"Unexpected error ({type(error).__name__})"


def deliver_pending(session_factory, settings: Settings, *, batch_size: int = 20) -> int:
    """Send due outbox rows. Returns the number successfully sent."""
    sent = 0
    with session_factory() as session:
        due = session.scalars(
            select(EmailNotification)
            .where(EmailNotification.status == "pending", EmailNotification.next_attempt_at <= _now())
            .order_by(EmailNotification.id)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        if not due:
            return 0
        config: dict[str, Any] | None = None
        config_error: Exception | None = None
        try:
            config = _load_smtp_config(session, settings)
        except Exception as error:
            config_error = error
        for item in due:
            item.attempts += 1
            try:
                if config_error is not None:
                    raise config_error
                user = session.get(User, item.user_id)
                if user is None or not user.is_active or not valid_email(user.email_address):
                    item.status = "skipped"
                    item.last_error = "Supervisor is inactive or has no valid email address"
                    LOGGER.warning("Notification %s skipped: %s", item.id, item.last_error)
                    continue
                message = build_message(item.payload, sender=config["from_address"],
                                        recipient=user.email_address.strip(), settings=settings)
                _send(config, message, settings.email_smtp_timeout_seconds)
                item.status = "sent"
                item.sent_at = _now()
                item.last_error = None
                sent += 1
                LOGGER.info("Notification %s (%s, alert %s) sent to user %s",
                            item.id, item.severity, item.alert_id, item.user_id)
            except Exception as error:
                item.last_error = _describe_error(error)
                if item.attempts >= settings.email_notification_max_attempts:
                    item.status = "failed"
                else:
                    delay = min(_RETRY_BASE_SECONDS * 2 ** (item.attempts - 1), _RETRY_MAX_SECONDS)
                    item.next_attempt_at = _now() + timedelta(seconds=delay)
                LOGGER.error("Notification %s attempt %s failed: %s", item.id, item.attempts, item.last_error)
        session.commit()
    return sent
