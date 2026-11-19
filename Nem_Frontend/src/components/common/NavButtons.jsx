import React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

// Shared back/forward navigation controls. Styling lives in styles/global.css (.nav-btn).
// - Page-level: <BackButton label="Maintenance schedules" onClick={...} /> renders the bordered
//   standalone button. Omit `label` for an icon-only control and pass `ariaLabel`.
// - `inline`: for action bars (modal footers, wizard steps). Keeps the caller's own button
//   classes (btn-outline, btn-primary, ...) and only adds the arrow icon.
function NavButton({ direction, label, ariaLabel, inline = false, className = "", children, type = "button", ...rest }) {
  const Icon = direction === "back" ? ArrowLeft : ArrowRight;
  const text = label ?? children;
  const iconOnly = text === undefined || text === null || text === "";
  const icon = <Icon className="nav-btn-icon" size={16} aria-hidden="true" />;
  const classes = inline
    ? `nav-btn-inline nav-btn-${direction}${className ? ` ${className}` : ""}`
    : `nav-btn nav-btn-${direction}${iconOnly ? " nav-btn-icon-only" : ""}${className ? ` ${className}` : ""}`;
  return (
    <button type={type} className={classes} aria-label={ariaLabel} title={iconOnly ? ariaLabel : undefined} {...rest}>
      {direction === "back" && icon}
      {!iconOnly && <span className="nav-btn-label">{text}</span>}
      {direction === "forward" && icon}
    </button>
  );
}

export const BackButton = (props) => <NavButton direction="back" {...props} />;
export const ForwardButton = (props) => <NavButton direction="forward" {...props} />;
