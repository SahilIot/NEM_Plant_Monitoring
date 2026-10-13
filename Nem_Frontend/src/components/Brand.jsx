import React from "react";
import { BRAND } from "../config.js";


export default function Brand() {
  return <img className="brand-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt={BRAND} />;
}