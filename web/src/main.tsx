import "@llmide/ui-kit/styles.css";
import "./web.css";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@llmide/ui-kit";
import { App } from "./App.tsx";

applyTheme(globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
createRoot(document.getElementById("root")!).render(<App />);
