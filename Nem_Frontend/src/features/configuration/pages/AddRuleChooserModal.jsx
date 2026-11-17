import React from "react";
import { FilePlus2, ListChecks } from "lucide-react";
import { Modal } from "../../../components/common/UI.jsx";
import { MAX_COLLECTION_RULES } from "./collectionLimits.js";
import "./AddRuleWorkflow.css";

/** First step of "Add rule" inside a collection: reuse an existing rule or create a new one. */
export default function AddRuleChooserModal({ collection, onSelectExisting, onCreateNew, onClose }) {
  return (
    <Modal title={`Add a rule to “${collection.name}”`} onClose={onClose}>
      <p className="muted add-rule-intro">
        This collection has {collection.ruleCount} of {MAX_COLLECTION_RULES} rules. How would you like to add a rule?
      </p>
      <div className="add-rule-options">
        <button type="button" className="add-rule-option" onClick={onSelectExisting}>
          <span className="add-rule-option-icon" aria-hidden="true"><ListChecks size={20} /></span>
          <span className="add-rule-option-text">
            <strong>Select Existing Rules</strong>
            <span>Pick reusable rules from the Monitoring Rule Library and move them into this collection.</span>
          </span>
        </button>
        <button type="button" className="add-rule-option" onClick={onCreateNew}>
          <span className="add-rule-option-icon" aria-hidden="true"><FilePlus2 size={20} /></span>
          <span className="add-rule-option-text">
            <strong>Create New Rule</strong>
            <span>Create an Interval Based or Parameter Threshold rule that is added to this collection straight away.</span>
          </span>
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
