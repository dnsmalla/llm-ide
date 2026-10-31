// @llmide/ui-kit: shared accessible components. Import "@llmide/ui-kit/styles.css" once
// (tokens + aliases + component styles) and set data-theme via applyTheme().
export { THEMES, DEFAULT_THEME_ID, isThemeId, applyTheme, type ThemeId } from "./theme";
export * from "./icons";
export { Chip } from "./components/Chip";
export { EditorTabBar, type EditorTab } from "./components/EditorTabBar";
export { FileTreeRow, type GitStatus } from "./components/FileTreeRow";
export { LibrarySidebar, SelectItemEmpty } from "./components/LibrarySidebar";
export { ResizableDivider, clampWidth, dragWidth, keyWidth } from "./components/ResizableDivider";
export { SectionChromeBar, type SectionToggle } from "./components/SectionChromeBar";
export { SettingsSectionCard } from "./components/SettingsSectionCard";
export { StatusBanner, type Severity } from "./components/StatusBanner";
