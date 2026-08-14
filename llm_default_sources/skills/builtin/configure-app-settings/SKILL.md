---
name: configure-app-settings
description: >-
  Configure theme and Settings: design tokens (colors, spacing, typography,
  radius, z-index, motion, elevation) plus user-facing Settings
  sections/toggles. Trigger on: "change brand color", "switch to dark mode",
  "add a toggle on Settings", "tighten spacing", "change font", "rename Settings
  section", "add notifications toggle", "delete account should be last", or
  edits to the theme: / settings: blocks in system.yaml. Do NOT hand-edit
  theme.css, DesignSystem.swift, DesignTokens.kt, or app/settings/page.tsx.
---

# Configure app settings (theme + user-facing Settings page)

Two config blocks drive every screen's look and the Settings UI:

| Block | Drives | Generated into |
|-------|--------|----------------|
| `theme:` | Colors, spacing, typography, radius, z-index, motion, elevation | `apps/web/styles/theme.css`, `apps/ios/.../Theme/DesignSystem.swift`, `apps/android/.../ui/theme/DesignTokens.kt` |
| `settings:` | User-facing Settings page (sections + toggles) | `apps/web/app/settings/page.tsx` |

Both are consumed by the shared primitives (`Screen`, `Surface`, `Text`, `Stack`, `Button`) — screens should never reference raw hex/px/dp. The Layer 3 compliance check enforces that.

## When to use

**Theme / tokens:**
- "Change brand color to #…"
- "Add a dark scheme"
- "Tighten the spacing scale"
- "Use JetBrains Mono for code"
- "Raise z-index of modals"
- "Slow down the fast motion duration"

**Settings page:**
- "Add a 'Beta features' toggle"
- "Put 'Delete account' at the bottom"
- "Rename 'Privacy' → 'Data'"
- "Add a link to /account/data"
- "Remove the push-notifications toggle"

## The theme surface (abridged — see system.yaml.example for full)

```yaml
theme:
  colors:                           # flat = light scheme; or use `schemes: {light, dark}` for both
    primary: "#6366F1"
    background: "#FFFFFF"
    surface: "#F3F4F6"
    # onPrimary, onSurface, border, focus, disabled, danger/warning/success all default

  schemes:                          # opt-in dark mode; partial dark overrides fall back to light
    light: { primary: "#6366F1", background: "#FFFFFF", surface: "#F3F4F6" }
    dark:  { primary: "#818CF8", background: "#0B0F1A", surface: "#111827" }

  layout:
    pageMargin: { mobile: 16, tablet: 24, desktop: 32 }
    spacing:   { xxs: 2, xs: 4, s: 8, m: 16, l: 24, xl: 32, xxl: 48 }
    breakpoints: { mobile: 600, tablet: 1024 }
    contentMaxWidth: 1200

  typography:
    fontFamily: "Inter"
    fontFamilyMono: "JetBrains Mono"  # optional
    scale:      { h1: 32, h2: 24, h3: 20, body: 16, bodySm: 14, caption: 12 }
    weight:     { regular: 400, medium: 500, semibold: 600, bold: 700 }
    lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.75 }

  components:
    radius: { xs: 2, s: 4, m: 8, l: 16, xl: 24, full: 9999 }
    buttonHeight: 48

  zIndex:    { base: 0, dropdown: 1000, sticky: 1100, fixed: 1200, modalBackdrop: 1300, modal: 1400, popover: 1500, tooltip: 1600 }

  motion:
    duration: { instant: 0, fast: 150, normal: 250, slow: 400 }
    easing:   { standard: "cubic-bezier(0.4, 0, 0.2, 1)", decelerate: "…", accelerate: "…" }

  elevation: { e0: 0, e1: 1, e2: 2, e3: 3, e4: 4 }

  style: "minimal"                  # minimal | glassmorphism | neumorphism
```

## The settings surface

```yaml
settings:
  sections:
    - id: "appearance"              # kebab-case
      title: "Appearance"
      items:
        - key: "themeMode"          # camelCase
          label: "Theme"
          type: "select"            # boolean | select | text | link | action
          default: "auto"
          options:
            - { value: "auto",  label: "System" }
            - { value: "light", label: "Light" }
            - { value: "dark",  label: "Dark" }
          requiresAuth: false       # when true, rendered only for authenticated users

    - id: "account"
      title: "Account"
      items:
        - { key: "security",       label: "Security & MFA", type: "link",   href: "/account/security" }
        - { key: "signOut",        label: "Sign out",       type: "action" }
        # App Store requirement — must be reachable from Settings.
        - { key: "deleteAccount",  label: "Delete account", type: "link",   href: "/account/delete", danger: true }
```

**Item types:**
- `boolean` → checkbox with `default` (true/false)
- `select` → dropdown with `default` + `options[]`
- `text` → input with `default` string
- `link` → `<Link href=…>` (internal route)
- `action` → button; with `href` behaves like a link, without `href` expects a client handler (e.g. `signOut`)

`danger: true` paints the row with `--color-danger` — use for destructive actions.

## Steps

1. **Edit `system.yaml`** — update `theme.*` and/or `settings.sections`.
2. **Regenerate tokens (if theme changed):** `./master.sh theme sync` → rewrites `theme.css`, `DesignSystem.swift`, `DesignTokens.kt` for both schemes.
3. **Regenerate Settings page (if settings changed):** `./master.sh generate:templates` → rewrites `apps/web/app/settings/page.tsx` from `settings.sections`.
4. **Verify compliance:** `./master.sh compliance` — the Layer 3 purity check runs; no raw hex/px/dp in screens.

## Common tasks

- **Rebrand:** change `theme.colors.primary` (or both `schemes.light.primary` and `schemes.dark.primary`). Re-run `theme sync`. All platforms pick up the new color via scheme-aware accessors.
- **Enable dark mode:** switch from flat `colors:` to `schemes: { light: {…}, dark: {…} }`. Undeclared dark roles fall back to the light value automatically. Re-run `theme sync`.
- **Tighten spacing:** reduce `layout.spacing` values. Shared `<Stack gap="m" />` etc. picks up the new scale — no screen edits needed.
- **Add a toggle:** append an item to the right section in `settings.sections`. Re-run `generate:templates`. The generated page renders it automatically.
- **Reorder toggles:** move items around in the section's `items[]` — the generator emits them in declared order.
- **Section visibility by auth:** mark `requiresAuth: false` on items that work for logged-out users (e.g. Appearance); the generated component emits them unconditionally.

## Guidelines

- **Never introduce raw color hex or pixel values in screen code.** If a screen needs a color, it uses `<Text role="danger" />` or a `<Button variant="primary" />`. The compliance check fails the build otherwise.
- **Dark mode is zero-config if you use the primitives.** Platforms read scheme-aware token accessors — no screen-level `colorScheme` branching.
- **Settings item keys are stable identifiers** — the value a toggle controls at runtime is keyed by `key` (not `label`). Rename `label` freely; changing `key` is a state-wipe for existing users.
- **Delete Account must stay reachable from Settings** (App Store requirement). Keep the item with `danger: true`.

## Output format

1. **Diff of `system.yaml`** — only the `theme.*` / `settings.*` fields that changed
2. **Regeneration log** — which files rewrote (`theme.css`, `DesignSystem.swift`, `DesignTokens.kt`, `app/settings/page.tsx`)
3. **Dark-mode coverage** (when touching colors) — note which roles are missing from `schemes.dark` and will fall back to light
4. **Compliance result** — Layer 3 purity scan summary
5. **Rule stack** — `.cursorrules → orchestration_policy.mdc → configure-app-settings/SKILL.md → AGENT_GUIDE.md → PRIMITIVES.md`

---

## Ready-to-paste: production-grade theme with full dark mode

```yaml
theme:
  style: "minimal"
  schemes:
    light:
      primary:      "#4F46E5"
      background:   "#FFFFFF"
      surface:      "#F8FAFC"
      onPrimary:    "#FFFFFF"
      onSurface:    "#0F172A"
      onBackground: "#0F172A"
      border:       "#E2E8F0"
      overlay:      "#000000"
      focus:        "#2563EB"
      disabled:     "#94A3B8"
      danger:       "#DC2626"
      warning:      "#F59E0B"
      success:      "#059669"
      text: { primary: "#0F172A", secondary: "#475569", tertiary: "#94A3B8" }
    dark:
      primary:      "#6366F1"
      background:   "#0B0F1A"
      surface:      "#111827"
      onPrimary:    "#0B0F1A"
      onSurface:    "#F1F5F9"
      onBackground: "#F1F5F9"
      border:       "#1F2937"
      overlay:      "#000000"
      focus:        "#818CF8"
      disabled:     "#475569"
      danger:       "#F87171"
      warning:      "#FBBF24"
      success:      "#34D399"
      text: { primary: "#F9FAFB", secondary: "#CBD5E1", tertiary: "#94A3B8" }

  layout:
    contentMaxWidth: 1200
    safeArea:    { top: true, bottom: true }
    pageMargin:  { mobile: 16, tablet: 24, desktop: 32 }
    spacing:     { xxs: 2, xs: 4, s: 8, m: 16, l: 24, xl: 32, xxl: 48 }
    breakpoints: { mobile: 600, tablet: 1024 }

  typography:
    fontFamily:     "Inter"
    fontFamilyMono: "JetBrains Mono"
    scale:      { h1: 32, h2: 24, h3: 20, body: 16, bodySm: 14, caption: 12 }
    weight:     { regular: 400, medium: 500, semibold: 600, bold: 700 }
    lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.75 }

  components:
    radius:       { xs: 2, s: 4, m: 8, l: 16, xl: 24, full: 9999 }
    buttonHeight: 48

  zIndex:   { base: 0, dropdown: 1000, sticky: 1100, fixed: 1200, modalBackdrop: 1300, modal: 1400, popover: 1500, tooltip: 1600 }
  motion:
    duration: { instant: 0, fast: 150, normal: 250, slow: 400 }
    easing:
      standard:   "cubic-bezier(0.4, 0.0, 0.2, 1)"
      decelerate: "cubic-bezier(0.0, 0.0, 0.2, 1)"
      accelerate: "cubic-bezier(0.4, 0.0, 1, 1)"
  elevation: { e0: 0, e1: 1, e2: 2, e3: 3, e4: 4 }
```

## Ready-to-paste: full settings page config

```yaml
settings:
  sections:
    - id: "appearance"
      title: "Appearance"
      items:
        - { key: "themeMode", label: "Theme", type: "select", default: "auto",
            options: [{ value: "auto", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
            requiresAuth: false }
        - { key: "reducedMotion", label: "Reduce animations", type: "boolean", default: false, requiresAuth: false }
        - { key: "language",      label: "Language", type: "select", default: "en",
            options: [{ value: "en", label: "English" }, { value: "ja", label: "日本語" }, { value: "es", label: "Español" }],
            requiresAuth: false }

    - id: "notifications"
      title: "Notifications"
      items:
        - { key: "emailDigest",    label: "Email digest (weekly summary)", type: "boolean", default: true }
        - { key: "emailMentions",  label: "Email me when I'm mentioned",   type: "boolean", default: true }
        - { key: "pushEnabled",    label: "Push notifications",            type: "boolean", default: true }
        - { key: "marketingEmail", label: "Product updates + tips",        type: "boolean", default: false }

    - id: "privacy"
      title: "Privacy & Data"
      items:
        - { key: "profileVisibility", label: "Profile visibility", type: "select", default: "members",
            options: [{ value: "public", label: "Public" }, { value: "members", label: "Members only" }, { value: "private", label: "Only me" }] }
        - { key: "telemetry",  label: "Share anonymous usage data", type: "boolean", default: false, requiresAuth: false }
        - { key: "dataExport", label: "Download your data",          type: "action",  href: "/account/data" }
        - { key: "sessions",   label: "Active sessions & devices",   type: "link",    href: "/account/sessions" }

    - id: "account"
      title: "Account"
      items:
        - { key: "profile",        label: "Edit profile",          type: "link",   href: "/account" }
        - { key: "security",       label: "Password & MFA",        type: "link",   href: "/account/security" }
        - { key: "billing",        label: "Billing & subscription", type: "link",   href: "/account/billing" }
        - { key: "signOut",        label: "Sign out",               type: "action" }
        - { key: "deleteAccount",  label: "Delete account",         type: "link",   href: "/account/delete", danger: true }
```

## Ready-to-paste: composing primitives in a new screen

Every screen looks like this — no raw hex, no raw px/dp:

```tsx
// apps/web/app/feed/page.tsx
import { Screen, Surface, Stack, Text, Button } from "../../components/shared";

export default function Feed() {
  return (
    <Screen>
      <Stack gap="l">
        <Text variant="h1">Feed</Text>
        <Surface radius="m" elevation={1}>
          <Stack gap="s">
            <Text variant="h3">Welcome back</Text>
            <Text role="secondary">You have 3 new updates.</Text>
            <Button variant="primary" onClick={() => {/* … */}}>View all</Button>
          </Stack>
        </Surface>
      </Stack>
    </Screen>
  );
}
```

iOS equivalent (`apps/ios/AppName/Views/Feed/FeedView.swift`):

```swift
struct FeedView: View {
    var body: some View {
        Screen {
            AppStack(.column, gap: .l) {
                AppText("Feed", variant: .h1, weight: .bold)
                Surface(radius: .m, elevation: 1) {
                    AppStack(.column, gap: .s) {
                        AppText("Welcome back", variant: .h3, weight: .semibold)
                        AppText("You have 3 new updates.", role: .secondary)
                        AppButton("View all") { /* … */ }
                    }
                }
            }
        }
    }
}
```

Android equivalent (`apps/android/.../ui/feed/FeedScreen.kt`):

```kotlin
@Composable
fun FeedScreen() {
    Screen {
        AppStack(direction = StackDirection.Column, gap = StackGap.L) {
            AppText("Feed", variant = TextVariant.H1, weight = FontWeight.Bold)
            AppSurface(radius = SurfaceRadius.M, elevation = DesignTokens.Elevation.E1) {
                AppStack(direction = StackDirection.Column, gap = StackGap.S) {
                    AppText("Welcome back", variant = TextVariant.H3, weight = FontWeight.SemiBold)
                    AppText("You have 3 new updates.", role = TextRole.Secondary)
                    AppButton("View all", onClick = { /* … */ })
                }
            }
        }
    }
}
```
