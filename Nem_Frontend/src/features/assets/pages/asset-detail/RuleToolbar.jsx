import React from "react";
import {
  ChevronDown,
  DotsIcon,
  FilterIcon,
  PlusCircle,
  RefreshIcon,
} from "../../../../components/common/Icons.jsx";
import { FloatingMenu } from "../../../../components/common/UI.jsx";

export default function RuleToolbar({ ctx }) {
  const {
    bulk,
    bulkSaving,
    canManageRules,
    children,
    filter,
    isSupervisor,
    list,
    menu,
    nAct,
    nNot,
    refreshAll,
    setChildren,
    setFilter,
    setList,
    setMenu,
    setModal,
    setShowFilter,
    setSort,
    setSortMenu,
    showFilter,
    sort,
    sortMenu,
  } = ctx;
  return (
    <div className="toolbar rule-toolbar">
      <button
        className={"icon-outline sm" + (showFilter ? " on" : "")}
        onClick={() => setShowFilter(!showFilter)}
        title="Filter rules"
        aria-label="Filter rules"
      >
        <FilterIcon size={17} />
      </button>

      {showFilter && (
        <input
          className="mini-input"
          placeholder="Filter rules"
          aria-label="Filter rules"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      <div className="segment">
        <button
          className={list === "activated" ? "active" : ""}
          onClick={() => setList("activated")}
        >
          Activated <span>({nAct})</span>
        </button>

        <button
          className={list === "not_activated" ? "active" : ""}
          onClick={() => setList("not_activated")}
        >
          Not activated <span>({nNot})</span>
        </button>
      </div>

      <button
        className="icon-outline sm"
        onClick={refreshAll}
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshIcon size={17} />
      </button>

      <label className="switch-label">
        <input
          type="checkbox"
          className="sr-only"
          checked={children}
          onChange={() => setChildren(!children)}
        />
        <span className={"switch" + (children ? " on" : "")} aria-hidden="true">
          <i />
        </span>
        Include child assets
      </label>

      <div className="spacer" />

      <div className="dropdown" data-menu-open={sortMenu}>
        <button
          className="link-btn"
          onClick={() => setSortMenu(!sortMenu)}
          aria-haspopup="menu"
          aria-expanded={sortMenu}
        >
          Sort by {sort === "name" ? "name" : "severity"}{" "}
          <ChevronDown size={14} />
        </button>

        {sortMenu && (
          <FloatingMenu role="menu">
            <div
              role="menuitem"
              onClick={() => {
                setSort("severity");
                setSortMenu(false);
              }}
            >
              Severity
            </div>

            <div
              role="menuitem"
              onClick={() => {
                setSort("name");
                setSortMenu(false);
              }}
            >
              Name
            </div>
          </FloatingMenu>
        )}
      </div>
      <button
        type="button"
        className="btn-primary"
        disabled={isSupervisor || !canManageRules}
        title={
          isSupervisor
            ? "Supervisors cannot add monitoring rules."
            : !canManageRules
              ? "You do not have permission to manage monitoring rules."
              : "Add rule"
        }
        onClick={() => {
          if (isSupervisor || !canManageRules) return;
          setModal("addRuleOptions");
        }}
      >
        <PlusCircle size={17} /> Add Rule
      </button>

      <div className="dropdown" data-menu-open={menu}>
        <button
          className="icon-outline sm"
          onClick={() => setMenu(!menu)}
          title="Rule actions"
          aria-label="Rule actions"
          aria-haspopup="menu"
          aria-expanded={menu}
        >
          <DotsIcon size={17} />
        </button>
        {menu && (
          <FloatingMenu align="right" role="menu">
            <button
              type="button"
              disabled={bulkSaving || !canManageRules}
              title={
                !canManageRules
                  ? "You do not have permission to manage monitoring rules."
                  : undefined
              }
              role="menuitem"
              onClick={() => bulk("activated")}
            >
              {bulkSaving ? "Updating rules…" : "Activate all rules"}
            </button>
            <button
              type="button"
              disabled={bulkSaving || !canManageRules}
              title={
                !canManageRules
                  ? "You do not have permission to manage monitoring rules."
                  : undefined
              }
              role="menuitem"
              onClick={() => bulk("not_activated")}
            >
              Deactivate all rules
            </button>
          </FloatingMenu>
        )}
      </div>
    </div>
  );
}
