# Responsible for cleaning, validating, and normalizing label names.
# Accept one label name and return name and key 
def normalize_label_name(value: str) -> tuple[str, str]:
    name = " ".join(value.split())
    if not 1 <= len(name) <= 255:
        raise ValueError("Labels must contain 1–255 characters.")
    return name, name.casefold()

#This function handles multiple labels at once 
def normalize_label_names(values: list[str] | None) -> list[str]:
    if values is None:
        return []
    if len(values) > 10:
        raise ValueError("A maximum of 10 labels may be assigned to an entry.")

    names: list[str] = []
    normalized: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise ValueError("Labels must be text values.")
        name, key = normalize_label_name(value)
        if key not in normalized:
            names.append(name)
            normalized.add(key)
    if len(names) > 10:
        raise ValueError("A maximum of 10 labels may be assigned to an entry.")
    return names
