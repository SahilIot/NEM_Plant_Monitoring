import { useState } from "react";

// Tooltip open-state shared by the parameter demos and the rule status detail: hover, keyboard focus and tap all open
// the same tooltip.
export function useTips() {
  const [active, setActive] = useState(null);
  const [pinned, setPinned] = useState(null);
  const point = (key, baseId) => ({
    onMouseEnter: () => setActive(key),
    onMouseLeave: () => setActive((c) => (c === key ? null : c)),
    onFocus: () => setActive(key),
    onBlur: () => { setActive((c) => (c === key ? null : c)); setPinned((c) => (c === key ? null : c)); },
    onClick: () => setPinned((c) => (c === key ? null : key)),
    onKeyDown: (e) => { if (e.key === "Escape") { setActive(null); setPinned(null); } },
    "aria-describedby": `${baseId}-tip-${key}`,
  });
  return { open: pinned || active, point };
}
