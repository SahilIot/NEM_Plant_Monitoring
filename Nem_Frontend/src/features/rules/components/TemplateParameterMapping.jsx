// Shared per-parameter variable pickers for reusable rules that have several parameters.
// Used by every assignment dialog (predefined rules, collections) so they behave the same.

export const isMultiTemplate = (template) =>
  Array.isArray(template?.parameter_candidates) && template.parameter_candidates.length > 0;

const chosen = (state, template, parameter) =>
  state?.[template.id]?.[parameter.key] ?? (parameter.mapped_variable_id ? String(parameter.mapped_variable_id) : "");

// A template is ready once every parameter that reads a variable has one.
export const mappingIncomplete = (template, state) => {
  if (isMultiTemplate(template)) {
    return template.parameter_candidates.some(
      (parameter) => parameter.uses_variable && !chosen(state, template, parameter)
    );
  }
  return Boolean(template?.variable_mapping_required) && !state?.[template.id];
};

// parameter_mappings request field: template id -> { parameter key -> variable id }.
export const parameterMappingsPayload = (templates, state) =>
  Object.fromEntries(
    templates.filter(isMultiTemplate).map((template) => [
      template.id,
      Object.fromEntries(
        template.parameter_candidates
          .filter((parameter) => parameter.uses_variable)
          .map((parameter) => [parameter.key, Number(chosen(state, template, parameter))])
          .filter(([, value]) => value)
      ),
    ])
  );

export default function TemplateParameterMapping({ template, state, onChange, disabled }) {
  if (!isMultiTemplate(template)) return null;
  return (
    <div className="tpm-list">
      {template.parameter_candidates.map((parameter) => (
        <label className="tpm-row" key={parameter.key}>
          <span className="tpm-name">
            {parameter.name}
            <small>{parameter.kind}{parameter.aggregation && parameter.aggregation !== "none" ? ` · ${String(parameter.aggregation).replaceAll("_", " ")}` : ""}</small>
          </span>
          {parameter.uses_variable ? (
            <select
              aria-label={`Variable for ${parameter.name} in ${template.name}`}
              value={chosen(state, template, parameter)}
              disabled={disabled}
              onChange={(event) => onChange(template.id, parameter.key, event.target.value)}
            >
              <option value="">Choose variable</option>
              {(parameter.compatible_variables || []).map((variable) => (
                <option value={variable.id} key={variable.id}>
                  {variable.name} · {variable.key} ({variable.data_type})
                </option>
              ))}
            </select>
          ) : (
            <em>Uses no variable</em>
          )}
        </label>
      ))}
    </div>
  );
}
