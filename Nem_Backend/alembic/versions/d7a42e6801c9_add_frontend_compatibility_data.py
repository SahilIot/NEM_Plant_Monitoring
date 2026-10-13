"""add frontend compatibility data

Revision ID: d7a42e6801c9
Revises: c1d841e06d33
Create Date: 2026-10-13 10:45:00.000000
"""
from alembic import op
import sqlalchemy as sa
from app.db.session import UTCDateTime


revision = "d7a42e6801c9"
down_revision = "c1d841e06d33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "frontend_config",
        sa.Column("key", sa.String(length=50), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "rule_collections",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "instruction_documents",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=50), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "frontend_backups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("file_name"),
    )


def downgrade() -> None:
    op.drop_table("frontend_backups")
    op.drop_table("instruction_documents")
    op.drop_table("rule_collections")
    op.drop_table("frontend_config")
