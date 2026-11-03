# Display helpers shared by models that carry created_by/updated_by audit columns.


def audit_user_name(user) -> str | None:
    # Return the audit user's display name, or None for legacy rows and deleted users.
    if user is None:
        return None
    return getattr(user, "username", None)


class AuditNamesMixin:
    # Expose ``created_by`` / ``updated_by`` display names from the audit relationships.
    @property
    def created_by(self) -> str | None:
        return audit_user_name(self.created_by_user)

    @property
    def updated_by(self) -> str | None:
        return audit_user_name(self.updated_by_user)
