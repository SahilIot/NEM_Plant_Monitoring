import React from "react";
import { useParams } from "react-router-dom";
import MultiParameterRulePage from "./MultiParameterRulePage.jsx";

const KNOWN_KINDS = ["interval", "usage", "time"];

// Interval Based creation for one asset: one rule, any number of interval parameters.
export default function RuleCreatePage() {
  const { kind } = useParams();
  if (!KNOWN_KINDS.includes(kind)) {
    return (
      <section className="panel">
        <p>Unknown rule type.</p>
      </section>
    );
  }
  return <MultiParameterRulePage category="interval_based" />;
}
