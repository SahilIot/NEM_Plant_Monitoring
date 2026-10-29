export const ORDER = { alert: 0, warning: 1, ok: 2 };

export const HEALTH_LABEL = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

export const LOG_FIELDS = [
  {
    key: "text",
    label: "Entry",
    type: "textarea",
    required: true,
    placeholder: "What was done or noticed?",
  },
];

export const VARIABLE_FIELDS = [
  {
    key: "name",
    label: "Name",
    required: true,
    placeholder: "e.g. Rotation count",
  },
  {
    key: "key",
    label: "Key",
    required: true,
    placeholder: "e.g. rotation_count",
    hint: "A short identifier that is unique within this asset.",
  },
  {
    key: "data_type",
    label: "Data type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Whole number"],
      ["boolean", "On / off"],
      ["string", "Text"],
    ],
  },
  {
    key: "signal_role",
    label: "Boolean purpose",
    type: "select",
    showWhen: { key: "data_type", equals: "boolean" },
    options: [
      ["running", "Machine running state (ON while running)"],
      ["cycle", "Cycle signal (OFF-to-ON means one cycle)"],
    ],
    hint: "Used when OPC UA mapping bypass is enabled. Choose the signal's actual meaning.",
  },
  {
    key: "unit",
    label: "Unit",
    placeholder: "e.g. °C, rpm, cycles",
  },
  {
    key: "opcua_node_id",
    label: "OPC UA NodeId",
    placeholder: "e.g. ns=2;s=Machine.Cycle",
    hint: "Optional. Enter the exact NodeId from the PLC. Restart the backend after changing it so the collector can subscribe.",
  },
  {
    key: "data_source",
    label: "Data source",
    type: "select",
    default: "none",
    options: [
      ["none", "No source"],
      ["connector", "Connector"],
    ],
  },
  {
    key: "connector_id",
    label: "Select connector",
    type: "select",
    default: "",
    options: [
      ["opcua", "OPC UA Connector"],
      ["mqtt", "MQTT Connector"],
      ["modbus_tcp", "Modbus TCP Connector"],
      ["http", "HTTP / REST API Connector"],
      ["database", "Database Connector"],
    ],
    showWhen: {
      key: "data_source",
      equals: "connector",
    },
    hint: "Choose the connector that provides this variable's data.",
  },
];
