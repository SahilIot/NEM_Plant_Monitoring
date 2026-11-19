import React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

// Shared back/forward navigation controls. Styling lives in styles/global.css (.nav-btn).
// Pass `label` as a short destination name ("Maintenance schedules"); omit it for an
// icon-only control and supply `ariaLabel` so the destination is still announced.
function NavButton({ direction, label, ariaLabel, className = "", children, type = "button", ...rest }) {
  const Icon = direction === "back" ? ArrowLeft : ArrowRight;
  const text = label ?? children;
  const iconOnly = text === undefined || text === null || text === "";
  const icon = <Icon className="nav-btn-icon" size={16} aria-hidden="true" />;
  return (
    <button
      type={type}
      className={`nav-btn nav-btn-${direction}${iconOnly ? " nav-btn-icon-only" : ""}${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      title={iconOnly ? ariaLabel : undefined}
      {...rest}
    >
      {direction === "back" && icon}
      {!iconOnly && <span className="nav-btn-label">{text}</span>}
      {direction === "forward" && icon}
    </button>
  );
}

export const BackButton = (props) => <NavButton direction="back" {...props} />;
export const ForwardButton = (props) => <NavButton direction="forward" {...props} />;
