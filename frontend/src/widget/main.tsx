import React from "react";
import ReactDOM from "react-dom/client";
import { Widget } from "../widget";

const rootEl = document.getElementById("oms-root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <Widget />
    </React.StrictMode>
  );
}
