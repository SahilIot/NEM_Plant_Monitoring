# Log of configuration packages imported by Administrators (non-authoritative source metadata)
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.session import UTCDateTime

# Defines a configuration import table history.
class ConfigurationImport(Base):
    # One committed import. The importing Administrator is the creator of every record it made.

    __tablename__ = "nem_configuration_imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    imported_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True )
    imported_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    # Taken from the file; informational only, never used for authorization or attribution.
    source_application: Mapped[str | None] = mapped_column(String(100))
    source_format_version: Mapped[str | None] = mapped_column(String(20))
    source_exported_at: Mapped[str | None] = mapped_column(String(40))
    duplicate_strategy: Mapped[str] = mapped_column(String(20), nullable=False)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)

    imported_by: Mapped["User | None"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[imported_by_id], lazy="selectin"
    )
