# DB migration for the shared labels feature.
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, MetaData, String, Table, insert, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine

from app.core.labels import normalize_label_names
from app.db.base import Base
from app.models.frontend_data import InstructionDocument
from app.models.labels import (
    Label,
    instruction_document_labels,
    rule_collection_labels,
    rule_labels,
    rule_template_labels,
)
#Unique indentifier for this migration . the db uses it to record whether the migration has been applied.
revision = "001_shared_labels"

#migration tracking table.
_migration_metadata = MetaData()
_schema_migrations = Table(
    "nem_schema_migrations",
    _migration_metadata,
    Column("revision", String(100), primary_key=True),
    Column("applied_at", DateTime(timezone=True), nullable=False),
)

# applying the migration.
def upgrade(engine: Engine) -> None:
    #start db transaction.
    with engine.begin() as connection:
        if engine.dialect.name == "postgresql":
            # prevent two processes from running the same migration simultaneously.
            connection.execute(text("SELECT pg_advisory_xact_lock(742913604118)"))
        _schema_migrations.create(connection, checkfirst=True)
        Base.metadata.create_all(
            bind=connection,
            tables=[
                Label.__table__,
                rule_labels,
                rule_template_labels,
                rule_collection_labels,
                instruction_document_labels,
            ],
        )
        applied = connection.scalar(select(_schema_migrations.c.revision).where(
                _schema_migrations.c.revision == revision
            )
        )

        labels = connection.execute(
            select(
                InstructionDocument.__table__.c.id,
                InstructionDocument.__table__.c.labels,
            )
        ).all()
        insert_function = pg_insert
        for document_id, legacy_names in labels:
            names = normalize_label_names(legacy_names or [])
            links: list[dict[str, int]] = []
            for name in names:
                normalized_name = name.casefold()
                connection.execute(
                    insert_function(Label.__table__)
                    .values(name=name, normalized_name=normalized_name)
                    .on_conflict_do_nothing(
                        index_elements=[Label.__table__.c.normalized_name]
                    )
                )
                label_id = connection.scalar(
                    select(Label.__table__.c.id).where(
                        Label.__table__.c.normalized_name == normalized_name
                    )
                )
                links.append({"document_id": document_id, "label_id": label_id})
            if links:
                connection.execute(
                    insert_function(instruction_document_labels)
                    .values(links)
                    .on_conflict_do_nothing()
                )
            if legacy_names:
                connection.execute(
                    update(InstructionDocument.__table__)
                    .where(InstructionDocument.__table__.c.id == document_id)
                    .values({InstructionDocument.__table__.c.labels: []})
                )

        if not applied:
            connection.execute(
                insert(_schema_migrations).values(
                    revision=revision,
                    applied_at=datetime.now(timezone.utc),
                )
            )

#Reversing the migration -> attempts to restore the old document-label format.
def downgrade(engine: Engine) -> None:
    with engine.begin() as connection:
        if engine.dialect.name == "postgresql":connection.execute(text("SELECT pg_advisory_xact_lock(742913604118)"))
        document_labels = connection.execute(
            select(
                instruction_document_labels.c.document_id,
                Label.name,
            )
            .join(Label,
                Label.id == instruction_document_labels.c.label_id,
            )
            .order_by(
                instruction_document_labels.c.document_id,
                instruction_document_labels.c.label_id,
            )
        ).all()
        #Group labels by document 
        names_by_document: dict[int, list[str]] = {}
        for document_id, name in document_labels:
            names_by_document.setdefault(document_id, []).append(name)
            #Restore the old labels field.
        for document_id, names in names_by_document.items():
            connection.execute(
                update(InstructionDocument.__table__)
                .where(InstructionDocument.__table__.c.id == document_id)
                .values({InstructionDocument.__table__.c.labels: names})
            )
        instruction_document_labels.drop(connection, checkfirst=True)
        rule_collection_labels.drop(connection, checkfirst=True)
        rule_labels.drop(connection, checkfirst=True)
        rule_template_labels.drop(connection, checkfirst=True)
        Label.__table__.drop(connection, checkfirst=True)
        connection.execute(_schema_migrations.delete().where( _schema_migrations.c.revision == revision))

# A database migration means making a planned change to your database structure or existing data when your application changes.
# Think of it as updating the database to match a new version of your application.