import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { setHostBridge } from "@llmide/screens/shell/host";
import { seedThemeFromHost } from "@llmide/screens/shell";
import { hydrateRepoConfig } from "@llmide/screens/settings/repo-config";
import { App } from "./App";
import "@llmide/ui-kit/styles.css";
import "./design/shell.css";
import "@llmide/screens/shell/shell.css";
import "@llmide/screens/shell/consistency.css";
import "./styles.css";

// Screens never import @tauri-apps/api (it is not resolvable from ui/screens): the host bridge is
// installed here, only inside the Tauri webview. In a plain browser the shell's fallbacks apply.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  setHostBridge({ invoke });
  // The host keeps the theme in prefs.json: used only if the webview's own storage lost the choice.
  void invoke<{ stored?: { theme?: unknown } }>("get_prefs").then((v) => seedThemeFromHost(v?.stored?.theme), () => undefined);
}

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
};

// The saved repository list lives in a host file. It is copied into webview storage before the first render, so no
// screen reads the defaults first. The wait is capped: a slow host must not hold the window shut.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  const hydrated = hydrateRepoConfig().catch(() => undefined);
  const capped = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  void Promise.race([hydrated, capped]).then(renderApp);
} else {
  renderApp();
}
