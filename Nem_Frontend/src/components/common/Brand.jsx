import React from "react";
import { BRAND } from "../../utils/config.js";


export default function Brand() {
  return <img className="brand-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt={BRAND} />;
}