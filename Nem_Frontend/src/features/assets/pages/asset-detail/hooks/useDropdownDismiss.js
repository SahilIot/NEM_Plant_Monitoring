import { useEffect } from "react";

// Closes open dropdown menus on outside click or Escape.
export default function useDropdownDismiss(ctx) {
  const {
    menu,
    sortMenu,
    ruleActionMenuId,
    setMenu,
    setSortMenu,
    setRuleActionMenuId,
  } = ctx;

  useEffect(() => {
    if (!menu && !sortMenu && ruleActionMenuId === null) return undefined;

    const closeMenus = () => {
      setMenu(false);
      setSortMenu(false);
      setRuleActionMenuId(null);
    };
    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      const openDropdowns = document.querySelectorAll(
        ".asset-page .dropdown[data-menu-open='true']",
      );
      if (event.target.closest(".floating-menu")) return;
      if (
        ![...openDropdowns].some((dropdown) => dropdown.contains(event.target))
      ) {
        closeMenus();
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, ruleActionMenuId, sortMenu]);
}
