# Team Hub: LLM from every platform, members by authority (review + plan, 2026-11-07)

**Status:** proposed, waiting for the user's answers to the five decisions in §4. Becomes ADR 0021 on approval.
**Written by:** the planning session. The coder takes no row from here before approval.

## 1. Review: why online access dropped after the Mac app

Facts checked 2026-11-07 in the repo (file pointers in brackets).

| # | What the Mac app + iPhone gave | What the desktop + web + iPhone give today | Cause |
|---|---|---|---|
| R1 | Phone found the Mac on the LAN by itself (Bonjour `_llmide._tcp`), PIN once, live AI | Phone and browser type a `ws://host:port/host-api/v1` URL and a PIN; LAN or Tailscale only | No discovery; every Host API surface is **off by default** (`LLMIDE_HOST_API_DEV`, `_READ`, `_COMPOSE`); TLS not default-on, and without TLS the listener refuses any non-loopback peer [`extension/server/host-api-listener.mjs:1`] |
| R2 | Phone had explorer sessions (new/load/delete), Auto Tasks (list/run/stop/toggle/history), images + PDF + md, voice | Phone: read-only session list, one quick chat, text attachments only, no Auto Tasks, no images [`schema/host-api/v1/commands.json`, `ios_app/.../LlmIdeControlView.swift:221`] | v1 has 20 commands in 7 capabilities; 5 Auto-Task and 2 session commands were never ported |
| R3 | — | Web app has Chat + a Sources viewer; the desktop has 14 sections [`web/src/App.tsx`, `ui/screens/shell/sections.ts:24`] | Web was built as the "phone web view", not as a workstation |
| R4 | — | VPS answers 404 on `/api/*` and `/host-api/*` since 2026-11-05 [`deploy/vps/README.md`] | A public core made **every user an admin**: `requireAdmin` only checks "logged in" [`extension/server/auth.mjs:82-95`]; one leaked login = code execution on the VPS |
| R5 | One user, one Mac | Still one user per core in practice; `users.role` and the JWT `role` claim exist but nothing enforces them; no team, org or member anywhere in desktop, core or schema | Product decision 2026-08-20 ("every authenticated user has full permission") was never revisited |
| R6 | Desktop off → phone off | Desktop off → read-only MEGA snapshot + queued prompts (ADR 0020), MEGA CORS still unverified | By design; sync can never run AI |

Verdict: the drop is real and has two roots. **Reach** (R1, R4, R6): the only machine that can run AI is a laptop that is often off, behind a NAT, with its remote surface switched off. **Authority** (R4, R5): the core cannot be exposed to more than one person because it has no enforced roles. The lost phone features (R2, R3) are the smaller part and are plain porting work.

## 2. The concept: one Team Hub, every surface a client

The Node core already runs headless (the Mac app spawned it; the VPS unit `llmide-core.service` still exists, disabled). The Host API v1 gateway, JWT auth, per-user tenancy, the vault with per-user keys (ADR 0015) and per-user model caps (`model_limits`, migration 0019) all live **in the core**, not in the desktop. So the hub is not a new service. It is the existing core started in **hub mode**:

```
                 ┌───────────────── Team Hub (the core, hub mode) ─────────────────┐
                 │ enforced roles · invites · per-member authority · audit         │
                 │ team KB (SQLite, user_id + project sharing) · AI with the       │
                 │ company key or the member's own vaulted key                     │
                 └──┬──────────────┬──────────────────┬───────────────────┬────────┘
            HTTPS+JWT        WSS Host API v1     WSS Host API v1       HTTPS+JWT
                 │                │                   │                   │
            Desktop app       Web app            iPhone app        Chrome extension
     (local core for offline;  (role-shaped        (role-shaped       (capture → hub,
      "Connect to hub")         screens)            screens)           chat from hub)
```

- **Where it runs:** the user's VPS (already paid; nginx + certbot there) for a team; or an always-on desktop at the office for a $0 LAN/Tailscale team. Same binary, same switch.
- **Who gets in:** invite only. The owner creates members with a role; registration stays closed. No public sign-up, so ADR 0020's "no public identity service" still holds: the hub is the team's own infrastructure.
- **Authority (the new part):** roles `owner > admin > member > viewer`, plus per-member grants the admin sets: projects the member may see, highest run mode (`none`, `read_only`, `execute`; `bypass` never remote), model allowlist and monthly USD cap (reusing `model_limits`, now admin-set), enabled features (the existing `LLMIDE_FEATURES` idea, per member), may-answer-approvals. One enforcement point in the core (`auth.mjs` + a route authority table); Host API capabilities at pairing become a function of the member's role (`issueDeviceToken` scopes), so phones and browsers inherit the same authority with no second model.
- **AI from every platform:** every client sends turns to the hub; the hub runs them in process with the member's authority. The desktop keeps its own local core for personal/offline work and gains "Connect to hub" (the existing adopt-a-core path, now with a remote URL + sign-in and `trust: "hub"`).
- **Data:** the team KB lives on the hub. Meetings, notes, plans, issues and chats carry `user_id` today; add project-level sharing (a `project_members` table) so a member sees the projects they are granted. Per-member chats stay private unless shared.
- **ADR 0020 sync stays** for the solo user without a server. The hub is the team path, not a replacement.

What this does not do: no screen sharing, no remote desktop (pivot of 2026-07-24 stands), no shared personal Claude login (against Anthropic terms; the company key is an API key, UN-051).

## 3. Plan: phases, gates, size

Sizes assume the agent-coord loop (coder codes, planner reviews). Each phase is one plan file with tasks, tests and an API/migration number when it ships.

| Phase | Work | Gate to exit | Size |
|---|---|---|---|
| **H0 Decide** | User answers §4; ADR 0021 written; MASTER-PLAN + USER-NEEDS rows added | ADR accepted | 0.5 d (planner) |
| **H1 Authority in the core** | Enforce `role` (`requireRole`, route authority table), migration: `members` grants (`project_members`, per-member `max_mode`, `features`, `can_approve`), admin-set `model_limits`, invite tokens (`POST /admin/invites`, single-use, 24 h), audit rows (who, what, project; never content). Retire the "every user is an admin" warning. Negative tests: a `viewer` cannot send a turn, a `member` cannot read another project, a revoked invite fails closed | `make regression` green; the negative-test list all red-to-green; API bump + migration | 2 d |
| **H2 Hub reachability** | Hub mode switch (`LLMIDE_HUB=1` ⇒ remote bind + TLS required + registration closed + invite-only + Host API served over WSS); shared PIN throttle; per-member rate limits; nginx reopens `/host-api/` and `/api/` only to the hub unit; `llmide-core.service` enabled with the hub env; Claude company key in the hub vault **or** `claude login` on the VPS (decision D2) | A member on the public domain pairs a phone and a browser, sends a turn, sees it audited; a non-member cannot register; TLS pinned fingerprint shown in Settings | 2 d + user's VPS steps |
| **H3 Desktop "Connect to hub"** | Settings › Team: hub URL + sign-in (JWT), adopted remote core with `trust: "hub"`, project list from the hub, member's features shape the sections, local core stays for offline; Team admin console (members, roles, grants, invites, audit) in the same Settings group | Two members on two desktops see only their granted projects; owner changes a grant and it applies on the next request | 2 d |
| **H4 Phone + web parity** | Port the 7 missing v1 commands: `autotasks.list/run/stop/toggle/history`, `chat.new` on iPhone, `chat.delete`; images under a capped `attachments_image` capability; LAN discovery (mDNS `_llmide._tcp` from the core, phone auto-fills the URL); web gets Library, Issues, Auto Tasks, Loop status as read-first screens, shown by role | iPhone matches the Mac-era feature list (R2 closed); web shows every granted section at phone width; capability enum regenerated for Swift/TS | 4 d |
| **H5 Team work** | Project sharing UI, member presence in chat, "who ran what" screen, per-member usage on the hub, push notifications to the member's devices (plan 3 already shipped the sender) | Owner demo: invite → pair → run → audit → revoke, on every surface | 2 d |
| **H6 Public exposure** | G-EXT external review (UN-075) of H1–H2; then invites by link on the public domain; App Store / Web Store listings reference the hub | Review findings closed | external |

Order of value: H1 + H2 restore online access with authority in under a week; H4 restores what the iPhone lost; H3/H5 make it a team product.

## 4. Decisions for the user (recommended answer first)

| # | Question | Recommended | Alternative |
|---|---|---|---|
| D1 | Where does the hub run first? | **The VPS** (always on, already paid, nginx + TLS there) | The owner's desktop over Tailscale ($0, off when the laptop is off, which is the complaint) |
| D2 | Which Claude credential runs team turns? | **One company API key in the hub vault, per-member USD caps** (ADR 0018 decision 5, UN-051; the caps code exists) | Each member's own key in the vault (ADR 0015; no shared bill, but each member needs a key) |
| D3 | Roles and default authority? | **owner / admin / member / viewer**; new member = `member`, `read_only` mode, all Claude models, 20 USD/month, no projects until granted | Fewer roles (admin / member) |
| D4 | May a member run `execute` from a phone or browser? | **No in v1**: `execute` only from a desktop connected to the hub; phones and browsers stay read-only (relay D2 ceiling, parity plan decision 3) | Execute from any surface with tool approvals |
| D5 | ADR 0020 sync after the hub? | **Keep** for solo users; a hub member does not need it (the hub is always on) | Retire sync once the hub ships |

Approve as recommended with one word and H0 starts; H1 goes to `agent-coord/requests.md` the same day.
