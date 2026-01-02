import React from "react";
import ReactDOM from "react-dom/client";
import { Widget } from "../widget";

const rootEl = document.getElementById("oms-root");
if (rootEl) {
  const timestamp = new Date().toISOString();
  rootEl.innerHTML = `OMS widget loaded ✅ ${timestamp}`;
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <Widget />
    </React.StrictMode>
  );
}
