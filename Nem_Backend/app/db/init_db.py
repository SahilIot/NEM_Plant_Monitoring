from sqlalchemy.engine import Engine

import app.models  # noqa: F401
from app.db.base import Base


def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
