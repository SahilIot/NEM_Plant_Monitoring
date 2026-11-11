from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from app.services import frontend_backup


class FakeTransaction:
    def __init__(self):
        self.is_active = True
        self.committed = False
        self.rolled_back = False

    def commit(self):
        self.committed = True
        self.is_active = False

    def rollback(self):
        self.rolled_back = True
        self.is_active = False


class FakeConnection:
    def __init__(self):
        self.transaction = FakeTransaction()
        self.statements = []
        self.closed = False

    def begin(self):
        return self.transaction

    def execute(self, statement, params=None):
        self.statements.append(str(statement))
        return SimpleNamespace(scalar=lambda: True)

    def close(self):
        self.closed = True


class FakeSource:
    version = 2

    def close(self):
        pass


class FakeContext:
    ids = {}
    attachment_names = []
    attachment_documents = {}
    counts = {}
    cleared = {}
    dropped = {}

    def reset_report(self):
        self.cleared = {}
        self.dropped = {}
        self.counts = {}


def setup_restore(monkeypatch, tmp_path):
    settings = SimpleNamespace(settings_encryption_key=SecretStr("test-secret"))
    target = tmp_path / "backup.zip"
    target.write_bytes(b"test")
    connection = FakeConnection()
    engine = SimpleNamespace(connect=lambda: connection)
    session = SimpleNamespace(new=[], dirty=[], deleted=[], expire_all=Mock())
    source = FakeSource()
    context = FakeContext()
    impact = {"cascade": [], "set_null": [], "set_default": [], "blockers": []}

    monkeypatch.setattr(frontend_backup, "resolve_backup_path", lambda *_: target)
    monkeypatch.setattr(frontend_backup, "_sha256", lambda _: "backup-hash")
    monkeypatch.setattr(frontend_backup, "_load", lambda *_: (source, False, [], context))
    monkeypatch.setattr(frontend_backup, "_stage_attachments", lambda *_: (None, {}, []))
    monkeypatch.setattr(frontend_backup, "_external_impact", lambda *_: (impact, []))
    monkeypatch.setattr(frontend_backup, "_promote_attachments", lambda *_: ([], None))
    monkeypatch.setattr(frontend_backup, "_post_restore_migrations", lambda *_: [])
    return settings, engine, session, connection, impact


def test_ordered_tables_is_available_to_backup_service():
    tables = frontend_backup._ordered_tables()

    assert tables
    assert all(table in frontend_backup._SCOPE_TABLES for table in tables)


# A restore with no external impact must still require the preview confirmation.
def test_restore_requires_preview_confirmation_even_without_external_impact(monkeypatch, tmp_path):
    settings, engine, session, connection, _impact = setup_restore(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as error:
        frontend_backup.restore_backup(session, engine, settings, "backup.zip")

    assert error.value.status_code == 409
    assert "explicit confirmation" in error.value.detail
    assert connection.transaction.rolled_back
    assert not connection.transaction.committed
    assert len(connection.statements) == 2


# A valid token issued for the reviewed backup and impact allows the restore to proceed.
def test_restore_accepts_valid_confirmation_from_preview(monkeypatch, tmp_path):
    settings, engine, session, connection, impact = setup_restore(monkeypatch, tmp_path)
    fingerprint = frontend_backup._impact_fingerprint("backup-hash", False, impact)
    token = frontend_backup._issue_confirmation(
        settings, "backup.zip", "backup-hash", fingerprint, user_id=None,
    )

    result = frontend_backup.restore_backup(
        session, engine, settings, "backup.zip", confirmation_token=token,
    )

    assert result["committed"] is True
    assert connection.transaction.committed
    assert not connection.transaction.rolled_back
    session.expire_all.assert_called_once()
