import React from "react";
import { Gauge, Timer } from "lucide-react";
import { RULE_CATEGORIES } from "../ruleCategories.js";
import "./RuleCategoryOptions.css";

const ICONS = { interval: Timer, parameter: Gauge };

/**
 * The one place rule creation offers a choice of rule type. Every creation entry point
 * renders this component, so labels, descriptions and icons stay identical.
 */
export default function RuleCategoryOptions({ onSelect, disabled = false }) {
  return (
    <div className="rule-category-options" role="group" aria-label="Rule type">
      {RULE_CATEGORIES.map(({ id, label, description }) => {
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            className="rule-category-option"
            disabled={disabled}
            onClick={() => onSelect(id)}
          >
            <span className="rule-category-icon" aria-hidden="true">
              <Icon size={20} />
            </span>
            <span className="rule-category-text">
              <strong>{label}</strong>
              <span>{description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
