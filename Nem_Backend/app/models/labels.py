# db structure for your shared labels system using SQLAlchemy.
from sqlalchemy import Column, ForeignKey, Index, String, Table
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

#Monitoring rule labels -> purpose is to connect monitoring rules with labels
rule_labels = Table(
    "monitoring_rule_labels",
    Base.metadata,
    Column("rule_id", ForeignKey("nem_monitoring_rules.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True),
)

#Works exactly like previous table , but connects labels to monitoring rule templates instead of actual monitoring rules.
rule_template_labels = Table(
    "monitoring_rule_template_labels",
    Base.metadata,
    Column("template_id", ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True),
)

# Association table linking monitoring rule template requests with labels using a many-to-many relationship.
rule_template_request_labels = Table(
    "monitoring_rule_template_request_labels",
    Base.metadata,
    Column(
        "request_id",
        ForeignKey(
            "nem_monitoring_rule_template_requests.id",
            ondelete="CASCADE",
        ),
        primary_key=True,
    ),
    Column(
        "label_id",
        ForeignKey("labels.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)

# connects labels to rule collections.
rule_collection_labels = Table(
    "rule_collection_labels",
    Base.metadata,
    Column("collection_id", ForeignKey("rule_collections.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True),
)

#This connects labels to uploaded instruction documents.
instruction_document_labels = Table(
    "instruction_document_labels",
    Base.metadata,
    Column("document_id", ForeignKey("instruction_documents.id", ondelete="CASCADE"), primary_key=True),
    Column("label_id", ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True),
)
#Creating indexes for label_id in all association tables to improve query performance when filtering by label_id.
for association in (
    rule_labels,
    rule_template_labels,
    rule_template_request_labels,
    rule_collection_labels,
    instruction_document_labels,
):
    Index(f"ix_{association.name}_label_id", association.c.label_id)

#The central label model. This defines the main labels db table.
class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
