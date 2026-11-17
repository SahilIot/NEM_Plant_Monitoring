import React from "react";
import { useParams } from "react-router-dom";
import MultiParameterRulePage from "../../rules/pages/MultiParameterRulePage.jsx";

// Parameter Threshold creation for one asset: one rule, any number of parameters.
// Interval Based creation lives in RuleCreatePage; both use the same parameter wizard.
export default function CreateMonitoringRulePage() {
  const { choiceId } = useParams();
  if (choiceId !== "parameter_threshold") {
    return (
      <section className="panel">
        <p>Unknown rule type.</p>
      </section>
    );
  }
  return <MultiParameterRulePage category="parameter_threshold" />;
}
