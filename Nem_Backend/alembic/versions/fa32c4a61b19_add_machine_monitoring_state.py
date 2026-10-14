"""add persistent machine monitoring state

Revision ID: fa32c4a61b19
Revises: d7a42e6801c9
Create Date: 2026-10-14 12:30:00.000000
"""
from alembic import op
import sqlalchemy as sa
from app.db.session import UTCDateTime


revision = "fa32c4a61b19"
down_revision = "d7a42e6801c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "machine_monitoring_states",
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("cycle_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "accumulated_running_seconds",
            sa.Numeric(precision=20, scale=3),
            nullable=False,
            server_default="0",
        ),
        sa.Column("cycle_signal", sa.Boolean(), nullable=True),
        sa.Column("is_running", sa.Boolean(), nullable=True),
        sa.Column("cycle_limit", sa.Integer(), nullable=True),
        sa.Column("runtime_limit_seconds", sa.Integer(), nullable=True),
        sa.Column("last_cycle_at", UTCDateTime(), nullable=True),
        sa.Column("last_cycle_signal_at", UTCDateTime(), nullable=True),
        sa.Column("last_running_signal_at", UTCDateTime(), nullable=True),
        sa.Column("last_seen_at", UTCDateTime(), nullable=True),
        sa.Column("runtime_checkpoint_at", UTCDateTime(), nullable=True),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("asset_id"),
    )


def downgrade() -> None:
    op.drop_table("machine_monitoring_states")
