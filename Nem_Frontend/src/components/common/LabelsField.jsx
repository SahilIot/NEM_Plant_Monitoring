import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../../services/api.js";
import "./LabelsField.css";

const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ");
const keyFor = (value) => normalize(value).toLowerCase();

export default function LabelsField({
  value = [],
  onChange,
  mode = "assign",
  disabled = false,
  id = "labels",
  refreshKey = 0,
}) {
  const [available, setAvailable] = useState([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const fieldRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!fieldRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    let active = true;
    api.get("/labels")
      .then((items) => {
        if (active) {
          setAvailable(Array.isArray(items) ? items : []);
          setError("");
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "Could not load labels.");
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const selectedIds = mode === "filter" ? value : [];
  const selectedNames = mode === "assign" ? value : [];
  const selectedOptions = useMemo(
    () => available.filter((label) => selectedIds.includes(label.id)),
    [available, selectedIds]
  );
  const suggestions = useMemo(() => {
    const query = keyFor(search);
    return available
      .filter((label) => (
        (!query || keyFor(label.name).includes(query)) &&
        (mode === "filter"
          ? true
          : !selectedNames.some((selected) => keyFor(selected) === keyFor(label.name)))
      ))
      .slice(0, 12);
  }, [available, mode, search, selectedNames]);

  const addName = (candidate = search) => {
    const name = normalize(candidate);
    if (!name) return;
    if (name.length > 255) {
      setError("Labels must be 255 characters or fewer.");
      return;
    }
    if (selectedNames.some((selected) => keyFor(selected) === keyFor(name))) {
      setError("This label is already selected.");
      return;
    }
    if (selectedNames.length >= 10) {
      setError("A maximum of 10 labels may be assigned to an entry.");
      return;
    }
    const existing = available.find((label) => keyFor(label.name) === keyFor(name));
    onChange([...selectedNames, existing?.name || name]);
    setSearch("");
    setOpen(false);
    setError("");
  };

  const toggleId = (labelId) => {
    const next = selectedIds.includes(labelId)
      ? selectedIds.filter((item) => item !== labelId)
      : [...selectedIds, labelId];
    onChange(next);
    setError("");
  };

  const removeName = (name) =>
    onChange(selectedNames.filter((item) => keyFor(item) !== keyFor(name)));

  if (mode === "filter") {
    return (
      <div className="labels-filter" ref={fieldRef}>
        <button
          type="button"
          className="labels-filter-toggle"
          aria-expanded={open}
          aria-label="Filter by labels"
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
        >
          Labels{selectedIds.length ? ` (${selectedIds.length})` : ""}
        </button>
        {selectedIds.length > 0 && (
          <button
            type="button"
            className="labels-filter-clear"
            onClick={() => onChange([])}
            disabled={disabled}
          >
            Clear
          </button>
        )}
        {open && (
          <div className="labels-filter-menu">
            <input
              type="search"
              aria-label="Search available labels"
              placeholder="Search labels..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
            <div className="labels-filter-options">
              {suggestions.map((label) => (
                <label key={label.id} className="labels-filter-option">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(label.id)}
                    onChange={() => toggleId(label.id)}
                    disabled={disabled}
                  />
                  <span>{label.name}</span>
                </label>
              ))}
              {suggestions.length === 0 && (
                <span className="labels-empty">No matching labels</span>
              )}
            </div>
            <small>Entries must have all selected labels.</small>
          </div>
        )}
        <div className="labels-chips">
          {selectedOptions.map((label) => (
            <span className="label-chip" key={label.id}>
              {label.name}
              <button
                type="button"
                aria-label={`Remove ${label.name} label filter`}
                onClick={() => toggleId(label.id)}
                disabled={disabled}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="labels-field" ref={fieldRef}>
      <div className="labels-input-row">
        <input
          id={id}
          type="text"
          value={search}
          maxLength={255}
          placeholder="Search or type a label"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-suggestions`}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setSearch(event.target.value);
            setOpen(true);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addName();
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="labels-add-button"
          aria-label="Add label"
          title="Add label"
          onClick={() => addName()}
          disabled={disabled || !normalize(search)}
        >
          <Plus size={17} />
        </button>
        {open && suggestions.length > 0 && (
          <div className="labels-suggestions" id={`${id}-suggestions`} role="listbox">
            {suggestions.map((label) => (
              <button
                type="button"
                key={label.id}
                role="option"
                aria-selected="false"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addName(label.name)}
                disabled={disabled}
              >
                <Plus size={14} />
                <span>{label.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="labels-chips">
        {selectedNames.map((name) => (
          <span className="label-chip" key={keyFor(name)}>
            {name}
            <button
              type="button"
              aria-label={`Remove ${name} label`}
              onClick={() => removeName(name)}
              disabled={disabled}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <small>{selectedNames.length}/10 labels</small>
      {error && <span className="labels-error" role="alert">{error}</span>}
    </div>
  );
}
