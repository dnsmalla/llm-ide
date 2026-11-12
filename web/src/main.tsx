import "./sync/pair-fragment.ts"; // first: strips #pair= before anything else runs (design 5.2)
import "@llmide/ui-kit/styles.css";
import "./ui/ui.css";
import "./shell/shell.css";
import "./web.css";
import { createRoot } from "react-dom/client";
import { initTheme } from "./ui/index.ts";
import { App } from "./App.tsx";

initTheme();

// Dev only: `#/__gallery/<screen>` renders a screen from fixtures for visual review. `import.meta.env.DEV` is a build-time
// constant, so the whole branch, and the gallery module with it, is removed from the production bundle.
async function mount() {
  const root = createRoot(document.getElementById("root")!);
  if (import.meta.env.DEV && location.hash.startsWith("#/__gallery")) {
    const { GalleryApp } = await import("./gallery/Gallery.tsx");
    root.render(<GalleryApp />);
    return;
  }
  root.render(<App />);
}
void mount();

// Production only: the dev server's module graph is not a stable shell, and a stale worker would hide edits.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
