import React from "react";
import { BRAND } from "../config.js";


export default function Brand() {
  return <img className="brand-logo" src="/logo.png" alt={BRAND} />;
}