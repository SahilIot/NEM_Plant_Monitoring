import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
import RuleCategoryOptions from "../../rules/components/RuleCategoryOptions.jsx";
import "../../rules/pages/RuleCreatePage.css";
import "./NewRuleWorkflow.css";

export const LIBRARY_PATH = "/configuration/rules";
export const COLLECTIONS_PATH = "/configuration/collections";

export default function RuleTypeSelectPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const suggest = Boolean(location.state?.suggest);
  const canCreateRules = user?.role === "Administrator" || (suggest && user?.role === "Supervisor");
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

        <RuleCategoryOptions
          disabled={!canCreateRules}
          onSelect={(category) =>
            navigate(`${LIBRARY_PATH}/new/${category === "interval" ? "interval" : "parameter"}`, {
              replace: true,
              state: { from, collection, suggest },
            })
          }
        />
      </div>
    </div>
  );
}
