// Docs vs code (formerly the Review Conflicts section): embedded by ui/screens/factory/FactoryScreen.tsx as a tab. Host seams are injected
// so the screen renders in tests without Tauri.
import type { SectionProps } from "@llmide/screens/shell";
import { invokeHost } from "../shell/host";
import { ReviewScreen, type ReviewDeps } from "./ReviewScreen.tsx";

export default function Review(props: SectionProps) {
  const deps: ReviewDeps = {
    list: (path) => invokeHost<unknown>("fs_list_dir", { req: { path, offset: 0, limit: 300, show_hidden: false, gitignore: true, hide_ignored: true } }),
    read: (path) => invokeHost<unknown>("fs_read_file", { req: { path, max_bytes: 1_000_000 } }),
  };
  return <ReviewScreen {...props} deps={deps} />;
}
