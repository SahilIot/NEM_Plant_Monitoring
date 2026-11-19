import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { LoadingIndicator } from "../../../components/common/UI.jsx";
import { rememberNavigationOrigin, returnToNavigationOrigin } from "../../../utils/navigation.js";
import ParameterRuleWizard from "../components/ParameterRuleWizard.jsx";
import { buildMultiParameterPayload } from "../components/parameterRules.js";
import { parameterForKind } from "../components/intervalConfig.js";
import "./RuleCreatePage.css";
import { BackButton } from "../../../components/common/NavButtons.jsx";

const COPY = {
  parameter_threshold: {
    title: "Create Parameter Threshold rule",
    description: "Monitor one or more signals in a single rule. Each parameter has its own variable, aggregation and limits, and the rule shows the most severe parameter status.",
  },
  interval_based: {
    title: "Create Interval Based rule",
    description: "Track how much a machine has been used and get a Due and an Overdue status when it is time for maintenance. One rule can follow several intervals.",
  },
};

// Asset-level creation of a rule with several parameters (POST /assets/{id}/multi-parameter-rules).
export default function MultiParameterRulePage({ category }) {
  const { user } = useAuth();
  const canManageRules = ["Administrator", "Supervisor"].includes(user?.role);
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { assets = [] } = useOutletContext() || {};
  const assetId = Number(id);
  const asset = assets.find((item) => Number(item.id) === assetId);
  const [variables, setVariables] = useState([]);
  const [eligible, setEligible] = useState({ running_signal: [], cycle_signal: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [items, plcStatus] = await Promise.all([
          api.getAll(`/assets/${assetId}/variables?is_active=true`),
          canManageRules ? api.get("/plc/status") : Promise.resolve(null),
        ]);
        if (!active) return;
        const mappings = Array.isArray(plcStatus?.mappings) ? plcStatus.mappings : [];
        const valid = mappings.filter((m) => Number(m.asset_id) === assetId && m.mapping_valid && m.data_type === "boolean");
        const idsFor = (role) => valid.filter((m) => m.role === role).map((m) => Number(m.variable_id));
        setVariables((Array.isArray(items) ? items : []).filter((item) => item.is_active !== false));
        setEligible({ running_signal: idsFor("running_signal"), cycle_signal: idsFor("cycle_signal") });
      } catch (error) {
        if (active) setLoadError(error.message || "Could not load this asset's variables.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [assetId, canManageRules]);

  const fallback = useMemo(() => ({ pathname: `/assets/${id}`, state: { activeTab: "status" } }), [id]);
  useEffect(() => { rememberNavigationOrigin(location.state?.from); }, [location.state?.from]);
  const goBack = () => returnToNavigationOrigin(navigate, location.state?.from, fallback);

  // A new rule starts with no parameters; the user adds each one with "+ Add Parameter".
  const initialValues = useMemo(() => ({
    name: "", periodAmount: "1", periodUnit: "hours", parameters: [],
    comment: "", instructions: "", link: "", documentIds: [], labels: [],
  }), []);
  // The entry route only chooses what the first interval parameter measures; the wizard owns it afterwards.
  const firstParameterDefaults = useMemo(() => {
    if (category !== "interval_based" || !kind) return null;
    const intervalParameter = parameterForKind(kind);
    return { intervalParameter, aggregation: intervalParameter === "counter" ? "counter" : "timer" };
  }, [category, kind]);

  const submit = async (values) => {
    const payload = buildMultiParameterPayload(values, category);
    await api.post(`/assets/${assetId}/multi-parameter-rules`, payload);
    returnToNavigationOrigin(navigate, location.state?.from, fallback, {
      notice: { text: `Rule "${payload.name}" created successfully.` },
    });
  };

  if (loading) return <LoadingIndicator className="loading" message="Loading variables" />;
  const copy = COPY[category];
  return (
    <div className="rule-create-page">
      <div className="rule-create-container">
        <BackButton className="rule-back-btn" label="Asset" onClick={goBack} />
        <div className="page-head rule-page-head">
          <span className="rule-create-kicker">MONITORING RULE</span>
          <h1 className="page-title rule-page-title">{copy.title}</h1>
          <p className="rule-page-description">{copy.description}</p>
          <p className="muted rule-page-subtitle"><span>Asset</span><strong>{asset?.name || `#${assetId}`}</strong></p>
        </div>
        <section className="rule-create-card">
          <ParameterRuleWizard
            category={category}
            assetId={assetId}
            assetName={asset?.name || `Asset #${assetId}`}
            variables={variables}
            eligible={eligible}
            canEdit={canManageRules}
            initialValues={initialValues}
            firstParameterDefaults={firstParameterDefaults}
            onSubmit={submit}
            onCancel={goBack}
            topNotice={<>
              {loadError && <p role="alert" className="error-message">{loadError}</p>}
              {!canManageRules && <p className="notice" role="status">You do not have permission to create monitoring rules.</p>}
            </>}
          />
        </section>
      </div>
    </div>
  );
}
