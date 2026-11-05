import "@llmide/ui-kit/styles.css";
import "./web.css";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@llmide/ui-kit";
import { App } from "./App.tsx";

applyTheme(globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
createRoot(document.getElementById("root")!).render(<App />);

// Production only: the dev server's module graph is not a stable shell, and a stale worker would hide edits.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
