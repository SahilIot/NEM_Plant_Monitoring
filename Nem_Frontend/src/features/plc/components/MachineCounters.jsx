import React from "react";
import { directionLabel } from "../../../utils/format.js";


export default function MachineCounters({ machine }) {
  const tracks = machine.tracks || {};
  return (
    <>
      {tracks.direction && (
        <div className="machine-fig">
          <span>Direction</span>
          <b className="plain">{directionLabel(machine.direction)}</b>
        </div>
      )}
      {tracks.clockwise && (
        <div className="machine-fig">
          <span>Clockwise</span>
          <b>{machine.clockwise_count ?? 0}</b>
        </div>
      )}
      {tracks.anticlockwise && (
        <div className="machine-fig">
          <span>Anticlockwise</span>
          <b>{machine.anticlockwise_count ?? 0}</b>
        </div>
      )}
    </>
  );
}