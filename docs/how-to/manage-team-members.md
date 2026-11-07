# Manage team members and invites (Settings → Team)

Settings → Team is the hub's member console (ADR 0021, API 123). It shows only while the signed-in user's
enforced team role is **owner** or **admin** (`GET /auth/me` → `member.teamRole`), and every route it calls
re-checks that role on the hub. On a solo install the single account is the owner, so the group is there too.

## Change a member's role, max mode or monthly USD cap

1. Open **Settings → Team**. The member list shows each account's email, display name, team role, max mode
   (`No runs`, `Read-only`, `Execute`), monthly USD cap and status.
2. Press **Edit** on a row, change the role, max mode or cap, then **Save changes**. Only changed fields are
   sent (`PATCH /admin/members/:userId`); the row updates from the server's answer and the list refreshes.
3. Rules the UI enforces before the server sees the request:
   - nobody can edit their own role or grants (`SELF_GRANT`);
   - an **admin cannot edit an owner**, and only an owner may grant the owner role;
   - the last owner cannot be demoted (`LAST_OWNER`);
   - the monthly cap is 0 (no cap) to 100000.
   A refused change shows the server's reason in plain text and leaves the row as it was.

`Execute` means the member may run write-capable turns from a desktop connected to the hub; phones and browsers
stay read-only in v1. A cap of 0 means no monthly USD cap.

## Invite someone

1. In **Invites**, choose the role (an admin can invite `member`/`viewer`; only an owner can invite an `admin` —
   an invite can never make an owner), the max mode, the monthly USD cap and how long the invite lasts
   (1–168 hours; 24 by default).
2. Optionally enter an email to bind the invite to that address. Leave it empty to let any address use it.
3. Press **Create invite**. The single-use token appears **once** with a **Copy token** button.
   Copy it now: the hub stores only its hash, so no screen or route can show it again.
4. Send the token to the invitee. They register with it even while the hub's registration is closed; using it
   burns it.

The token is held only in the Settings screen's memory. It is never written to `localStorage`, never logged, and
it disappears when you press **Done**, create another invite, or revoke that invite.

## Revoke an invite

Each unused invite row has **Revoke** behind an inline confirmation. Revoking deletes the invite, so its token
stops working. Used invites are listed as read-only history.

## Why a member or viewer cannot see this screen

The core's `members` row is the authority, not `users.role`. An account at `member` or `viewer` gets
`403 ROLE_DENIED` from the admin routes, so the Settings row is hidden rather than shown with dead controls.
Ask an owner or admin to change the role first.
