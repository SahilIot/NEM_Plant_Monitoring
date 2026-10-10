from sqlalchemy.engine import Engine

from app.db.base import Base
from app.models import Asset, MonitoringRule, Reading, Variable  # noqa: F401


def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
