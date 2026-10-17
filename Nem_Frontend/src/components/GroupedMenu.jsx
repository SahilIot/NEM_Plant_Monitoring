import React, { useState } from "react";
import { Link } from "react-router-dom";
import "./GroupedMenu.css";


const ICONS = {
  rules: "M3 12h4l2.5-6 4 12 2.5-6H21",
  collections: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  documents: "M7 4h10v17H7zM10 2h4v4h-4zM10 11h4M10 15h4",
  import: "M12 20V7M6 13l6-6 6 6M5 3h14",
  user: "M12 4a4 4 0 100 8 4 4 0 000-8zM4 20c0-4 3.5-6 8-6s8 2 8 6z",
  email: "M3 6h18v12H3zM3 7l9 7 9-7",
  analytics: "M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  usage: "M5 20v-8M12 20V5M19 20v-9",
  backup: "M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 10a4 4 0 01-1 8H7zM12 12v5M9.5 14.5L12 12l2.5 2.5",
};

function Icon({ name }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] || ICONS.rules} />
    </svg>
  );
}


export default function GroupedMenu({ title, items, badges = {} }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = items.filter((x) => `${x.title} ${x.desc}`.toLowerCase().includes(needle));
  const groups = [...new Set(shown.map((x) => x.group))];

  return (
    <div className="gm">
      <h1>{title}</h1>
      <input
        className="gm-search"
        placeholder={`Search ${title.toLowerCase()}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 ? (
        <div className="gm-none">Nothing found.</div>
      ) : (
        groups.map((g) => (
          <div className="gm-group" key={g}>
            <h3>{g}</h3>
            <div className="gm-grid">
              {shown.filter((x) => x.group === g).map((x) => (
                <Link key={x.to} to={x.to} className="gm-card">
                  <div className="gm-top">
                    <span className="gm-chip"><Icon name={x.icon} /></span>
                    {badges[x.to] ? <span className="gm-pill">{badges[x.to]}</span> : null}
                  </div>
                  <div className="gm-text">
                    <b>{x.title}</b>
                    <p>{x.desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}