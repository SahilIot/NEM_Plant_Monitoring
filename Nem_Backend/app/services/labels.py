# actual label assignment and filtering operations.
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.labels import normalize_label_names
from app.models.frontend_data import InstructionDocument
from app.models.labels import Label

#This function filters db records according to the labels selected by the user.
def apply_label_filter(query, model, label_ids: list[int] | None):
    unique_ids = list(dict.fromkeys(label_ids or []))
    if any(label_id <= 0 for label_id in unique_ids):
        raise ValueError("Label IDs must be positive integers.")
    for label_id in unique_ids:
        query = query.where(model.label_records.any(Label.id == label_id))
    return query

# This function checks whether labels already exist in the shared labels table. if they do not exist, it creates theem.
def resolve_labels(session: Session, names: list[str] | None) -> list[Label]:
    labels: list[Label] = []
    for name in normalize_label_names(names):
        normalized_name = name.casefold()
        label = session.scalar(select(Label).where(Label.normalized_name == normalized_name))
        if label is None:
            try:
                # Important: it creates a savepoint, which is a smaller rollback boundary inside the current db transaction.
                with session.begin_nested():
                    label = Label(name=name, normalized_name=normalized_name)
                    session.add(label)
                    session.flush()
            except IntegrityError:
                label = session.scalar(select(Label).where(Label.normalized_name == normalized_name))
                if label is None:
                    raise
        labels.append(label)
    return labels

#This function actually assigns labels to a particular application entry.
def assign_labels(session: Session,entry,names: list[str] | None,) -> None:
    labels = resolve_labels(session, names)
    entry.label_records = labels
    if isinstance(entry, InstructionDocument):
        entry.legacy_labels = []
