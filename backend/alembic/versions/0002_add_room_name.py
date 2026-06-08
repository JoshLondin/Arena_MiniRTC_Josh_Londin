"""add room name

Revision ID: 0002_add_room_name
Revises: 0001_initial_schema
Create Date: 2026-06-08
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_add_room_name"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("name", sa.Text(), nullable=True))
    op.execute("UPDATE rooms SET name = room_code WHERE name IS NULL")
    op.alter_column("rooms", "name", nullable=False)


def downgrade() -> None:
    op.drop_column("rooms", "name")
