from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app import models  # noqa: F401


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    database = tmp_path / "test-machine-monitor.db"
    settings = Settings(
        database_url=f"sqlite:///{database.as_posix()}",
        monitoring_scheduler_enabled=False,
        monitoring_default_stale_after_seconds=3600,
    )
    application = create_app(settings)
    Base.metadata.create_all(application.state.engine)
    with TestClient(application) as test_client:
        yield test_client
