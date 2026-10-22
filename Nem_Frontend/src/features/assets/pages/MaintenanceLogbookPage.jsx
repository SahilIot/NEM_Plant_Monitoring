
import React, { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./MaintenanceLogbookPage.css";

export default function MaintenanceLogbookPage({
  records = [],
  schedules = [],
}) {
  const navigate = useNavigate();
  const { id } = useParams();

  const counts = useMemo(() => {
    return records.reduce(
      (result, record) => {
        if (record.status === "in_progress") {
          result.inProgress += 1;
        }

        if (record.status === "completed") {
          result.completed += 1;
        }

        return result;
      },
      {
        upcoming: schedules.filter(
          (item) => item.due_status === "upcoming"
        ).length,

        dueToday: schedules.filter(
          (item) => item.due_status === "due_today"
        ).length,

        inProgress: 0,
        overdue: schedules.filter(
          (item) => item.due_status === "overdue"
        ).length,
        completed: 0,
      }
    );
  }, [records, schedules]);

  const maintenanceStatuses = [
    {
      title: "Upcoming",
      count: counts.upcoming,
    },
    {
      title: "Due Today",
      count: counts.dueToday,
    },
    {
      title: "In Progress",
      count: counts.inProgress,
    },
    {
      title: "Overdue",
      count: counts.overdue,
    },
    {
      title: "Completed",
      count: counts.completed,
    },
  ];

 
return (
  <main className="maintenance-logbook-page">
    <header className="maintenance-logbook-header">
      <button
        type="button"
        onClick={() =>
          navigate(`/assets/${id}`, {
            state: { activeTab: "logbook" },
          })
        }
      >
        ← Back to Maintenance log
      </button>

      <div>
        <h1>Maintenance Logbook</h1>
        <p>
          Track maintenance status and records for this asset.
        </p>
      </div>
    </header>

      <section className="maintenance-logbook-grid">
        {maintenanceStatuses.map((status) => (
          <article
            className="maintenance-logbook-card"
            key={status.title}
          >
            <h2>{status.title}</h2>
            <p className="maintenance-logbook-count">
              {status.count}
            </p>
            <p>Maintenance records</p>
          </article>
        ))}
      </section>
    </main>
  );
}
