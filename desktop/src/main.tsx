import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { setHostBridge } from "@llmide/screens/shell/host";
import { App } from "./App";
import "@llmide/ui-kit/styles.css";
import "./design/shell.css";
import "@llmide/screens/shell/shell.css";
import "./styles.css";

// Screens never import @tauri-apps/api (it is not resolvable from ui/screens): the host bridge is
// installed here, only inside the Tauri webview. In a plain browser the shell's fallbacks apply.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  setHostBridge({ invoke });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
