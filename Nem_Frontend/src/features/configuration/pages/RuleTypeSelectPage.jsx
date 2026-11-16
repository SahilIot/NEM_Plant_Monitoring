import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Cog, RefreshCw } from "lucide-react";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
import "../../rules/pages/RuleCreatePage.css";
import "./NewRuleWorkflow.css";

export const LIBRARY_PATH = "/configuration/rules";
export const COLLECTIONS_PATH = "/configuration/collections";

// Reusable-rule types that have a full-page creation form. Temperature Based and
// Parameter threshold templates are still created in the existing rule modal.
export const NEW_RULE_TYPES = [
  {
    kind: "motor-running",
    title: "Motor Running",
    description:
      "Monitor machine running conditions and configured running-duration thresholds.",
    Icon: Cog,
  },
  {
    kind: "cycle-clock",
    title: "Cycle Clock",
    description:
      "Monitor machine cycles and accumulated cycle thresholds.",
    Icon: RefreshCw,
  },
];

export default function RuleTypeSelectPage() {
  const { user } = useAuth();
  const canCreateRules = user?.role === "Administrator";
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  // Set when the rule is being added from inside a Rule Collection.
  const collection = location.state?.collection || null;

  useEffect(() => {
    rememberNavigationOrigin(from);
  }, [from]);

  const backToLibrary = () =>
    returnToNavigationOrigin(
      navigate,
      from,
      collection ? COLLECTIONS_PATH : LIBRARY_PATH
    );

  // The existing reusable-rule modal stays available for the other rule types.
  const openOtherRuleTypes = () =>
    collection?.draft
      ? navigate(COLLECTIONS_PATH, {
          replace: true,
          state: { ...(from?.state || {}), openOtherRule: true },
        })
      : collection
      ? navigate(COLLECTIONS_PATH, {
          replace: true,
          state: { ...(from?.state || {}), openAddRule: collection },
        })
      : navigate(LIBRARY_PATH, {
          replace: true,
          state: { ...(from?.state || {}), openCreate: true },
        });

  return (
    <div className="rule-create-page rule-create-page-select">
      <div className="rule-create-container">
        <button
          type="button"
          className="btn-outline rule-back-btn"
          onClick={backToLibrary}
        >
          {collection?.draft ? "← Back to collection form" : collection ? "← Back to Collection" : "← Back to Rule Library"}
        </button>

        <div className="page-head rule-page-head">
          <span className="rule-create-kicker">NEW RULE</span>
          <h1 className="page-title rule-page-title">
            Which type of monitoring rule would you like to create?
          </h1>
          <p className="rule-page-description">
            {collection?.draft
              ? "The rule is added to the collection you are creating and is saved when you create the collection."
              : collection
              ? `The rule is saved and added to the “${collection.name}” collection, from where it can be assigned to assets.`
              : "The rule is saved to the Monitoring Rule Library, from where it can be assigned to assets."}
          </p>
        </div>

        {!canCreateRules && (
          <p className="notice" role="status">
            Only Administrators can create reusable monitoring rules.
          </p>
        )}

        <div className="rule-type-grid">
          {NEW_RULE_TYPES.map(({ kind, title, description, Icon }) => (
            <button
              key={kind}
              type="button"
              className="rule-type-card"
              disabled={!canCreateRules}
              onClick={() =>
                navigate(`${LIBRARY_PATH}/new/${kind}`, {
                  replace: true,
                  state: { from, collection },
                })
              }
            >
              <span className="rule-type-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span className="rule-type-text">
                <strong>{title}</strong>
                <span>{description}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="rule-type-other">
          Need a Temperature Based or Parameter threshold rule?{" "}
          <button
            type="button"
            className="rule-type-link"
            onClick={openOtherRuleTypes}
            disabled={!canCreateRules}
          >
            Other rule types
          </button>
        </p>
      </div>
    </div>
  );
}
