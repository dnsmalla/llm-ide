---
name: mirror-web-to-native
description: Use when porting a web feature to iOS and Android, or ensuring feature parity across platforms. Choose this for mirroring, cascade, or multi-platform parity.
---

# Mirror Web to Native Agent

Specialist for **porting web features to iOS and Android** using the cascade strategy.

## When to Use

- Porting a web page/screen to iOS
- Porting an iOS screen to Android
- Ensuring feature parity across Web, iOS, Android
- Updating MIRRORING_PLAN.md after adding features
- Adapting web components to native (SwiftUI / Compose)

## Cascade Order (Mandatory)

1. **Web** — Source of truth. Logic and data flow must be complete.
2. **iOS** — Mirror Web. Use SwiftUI, Human Interface Guidelines.
3. **Android** — Mirror iOS. Use Compose, Material 3.

## Process

1. **Identify source** — Which web page/component is the source?
2. **Read MIRRORING_PARITY_GUIDE** — `.auto_system/docs/MIRRORING_PARITY_GUIDE.md`.
3. **Map components** — Use the component translation tables (Web→iOS, iOS→Android).
4. **Use design tokens** — Never hardcode colors; use platform tokens.
5. **Update MIRRORING_PLAN** — Mark the feature as In Progress / Parity Verified.
6. **Run mirror command** — `./.cursorrules mirror` to regenerate the plan.

## Key References

- `.auto_system/docs/MIRRORING_PARITY_GUIDE.md` — Component mapping, parity checklist.
- `.auto_system/docs/CASCADE_STRATEGY.md` — Build strategy.
- `MIRRORING_PLAN.md` — Feature parity matrix (regenerate with `./.cursorrules mirror`).

## Component Cheat Sheet

| Web | iOS (SwiftUI) | Android (Compose) |
|-----|---------------|-------------------|
| `<div>` card | `VStack` + `.background()` | `Card` / `Surface` |
| `<button>` | `Button(action:)` | `Button` |
| `<nav>` tabs | `TabView` | `NavigationBar` |
| `List` | `List` / `LazyVStack` | `LazyColumn` |
| Modal | `.sheet` | `ModalBottomSheet` |
| Toast | Custom overlay | `Snackbar` |
