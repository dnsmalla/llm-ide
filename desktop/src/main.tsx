import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@llmide/ui-kit/styles.css";
import "./design/shell.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
