"""initial schema

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-05-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rooms",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("room_code", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("call_status", sa.Text(), nullable=False, server_default="IDLE"),
        sa.Column("call_host_participant_id", sa.Uuid(), nullable=True),
        sa.Column("host_participant_id", sa.Uuid(), nullable=True),
        sa.Column("host_token_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "participants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("room_id", sa.Uuid(), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("participant_token_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconnect_deadline_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("disconnect_context", sa.Text(), nullable=True),
        sa.Column("media_connected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint("idx_rooms_room_code", "rooms", ["room_code"])
    op.create_index("idx_participants_room_id", "participants", ["room_id"])
    op.create_index("idx_participants_room_status", "participants", ["room_id", "status"])
    op.create_index("idx_participants_reconnect_deadline", "participants", ["reconnect_deadline_at"])


def downgrade() -> None:
    op.drop_index("idx_participants_reconnect_deadline", table_name="participants")
    op.drop_index("idx_participants_room_status", table_name="participants")
    op.drop_index("idx_participants_room_id", table_name="participants")
    op.drop_constraint("idx_rooms_room_code", "rooms", type_="unique")
    op.drop_table("participants")
    op.drop_table("rooms")

