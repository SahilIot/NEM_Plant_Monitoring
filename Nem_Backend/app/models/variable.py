# stores the variables or signals that belong to each machine 
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.session import UTCDateTime

if TYPE_CHECKING:
    from app.models.asset import Asset

class Variable(Base):
    __tablename__ = "variables"
    __table_args__ = (
        UniqueConstraint("asset_id", "key", name="uq_variables_asset_key"),
        Index("ix_variables_asset_active", "asset_id", "is_active"),
        Index("ix_variables_opcua_node_id", "opcua_node_id", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    data_type: Mapped[str] = mapped_column(String(20), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(Text)

    # Optional link to a discovered OPC UA node on the PLC.
    opcua_node_id: Mapped[str | None] = mapped_column(String(512),nullable=True,)

    is_active: Mapped[bool] = mapped_column(Boolean,default=True,nullable=False,index=True,)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    asset: Mapped["Asset"] = relationship(back_populates="variables")
'''
    Asset tells the system which machine it is monitoring. 
    Variable tells it which signal on that machine it cares about. 
    Reading stores the values received from that signal over time.
    '''