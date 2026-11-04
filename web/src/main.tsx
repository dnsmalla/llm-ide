import "@llmide/ui-kit/styles.css";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@llmide/ui-kit";

applyTheme(globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
createRoot(document.getElementById("root")!).render(<main className="web-app"><h1>LLM-IDE Web</h1></main>);
