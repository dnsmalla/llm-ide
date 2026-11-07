// Presentational pieces for Settings → Team (ADR 0021 H2 local/UI part). Pure props in, markup out: the
// container (TeamSection.tsx) owns loading, the calls and the token's one-shot state, so these views are
// render-tested without a live core. Text is always React children (escaped); a token is plain text here.
import { Button, Field } from "../ui.tsx";
import {
  MAX_INVITE_TTL_HOURS, MAX_MODES, MAX_USD_CAP_MONTH, TOKEN_ONCE_WARNING,
  buildMemberPatch, canManageTeam, dbTimeLabel, formatUsdCap, grantableRoles, inviteDraftProblem,
  inviteRolesFor, inviteState, isMaxMode, isTeamRole, maxModeLabel, memberDraftProblem, memberEditBlock,
  roleLabel, statusLabel, type CreatedInvite, type InviteDraft, type MemberDraft, type TeamInvite, type TeamMember,
  type TeamRole,
} from "../team-model.ts";

export function TeamAccessNotice({ teamRole }: { teamRole: TeamRole | null }) {
  if (canManageTeam(teamRole)) return null;
  return (
    <p className="st-hint" role="status">
      Only the team owner and admins can see members and invites.{teamRole ? ` Your team role is ${roleLabel(teamRole)}.` : ""}
    </p>
  );
}

export interface MemberRowProps {
  member: TeamMember;
  actorRole: TeamRole;
  selfId: string;
  onEdit: () => void;
}

export function MemberRowView({ member, actorRole, selfId, onEdit }: MemberRowProps) {
  const blocked = memberEditBlock(member, actorRole, selfId);
  return (
    <li className="st-team-row" role="listitem">
      <div className="st-item-text">
        <strong>{member.displayName || member.email}</strong>
        <span className="st-hint">{member.email}</span>
        <span className="st-hint">
          {roleLabel(member.teamRole)} · {maxModeLabel(member.maxMode)} · {formatUsdCap(member.usdCapMonth)} · {statusLabel(member.status)}
        </span>
      </div>
      {blocked ? <p className="st-hint">{blocked}</p> : <Button onClick={onEdit} label={`Edit ${member.email}`}>Edit</Button>}
    </li>
  );
}

export interface MemberEditorProps {
  member: TeamMember;
  actorRole: TeamRole;
  selfId: string;
  draft: MemberDraft;
  onChange: (draft: MemberDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}

export function MemberEditorView({ member, actorRole, selfId, draft, onChange, onSave, onCancel, busy }: MemberEditorProps) {
  const problem = memberDraftProblem(member, draft, actorRole, selfId);
  const canSave = !busy && problem === null && buildMemberPatch(member, draft) !== null;
  return (
    <li className="st-team-row" role="listitem">
      <form
        className="st-stack st-grow"
        aria-label={`Edit ${member.email}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onSave();
        }}
      >
        <p className="st-label">Edit {member.email}</p>
        <div className="st-team-fields">
          <Field label="Team role">
            <select
              className="st-select"
              value={draft.teamRole}
              onChange={(e) => {
                const v = e.target.value;
                if (isTeamRole(v)) onChange({ ...draft, teamRole: v });
              }}
            >
              {grantableRoles(actorRole).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Max mode">
            <select
              className="st-select"
              value={draft.maxMode}
              onChange={(e) => {
                const v = e.target.value;
                if (isMaxMode(v)) onChange({ ...draft, maxMode: v });
              }}
            >
              {MAX_MODES.map((m) => <option key={m} value={m}>{maxModeLabel(m)}</option>)}
            </select>
          </Field>
          <Field label="Monthly USD cap" hint="0 means no cap; up to 100000.">
            <input
              className="st-input"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_USD_CAP_MONTH}
              step="0.01"
              value={draft.usdCapMonth}
              onChange={(e) => onChange({ ...draft, usdCapMonth: e.target.value })}
            />
          </Field>
        </div>
        {problem ? <p className="st-error" role="alert">{problem}</p> : null}
        <div className="st-row">
          <Button tone="primary" disabled={!canSave} onClick={onSave}>Save changes</Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </li>
  );
}

export interface InviteFormProps {
  actorRole: TeamRole;
  draft: InviteDraft;
  onChange: (draft: InviteDraft) => void;
  onSubmit: () => void;
  busy: boolean;
}

export function InviteFormView({ actorRole, draft, onChange, onSubmit, busy }: InviteFormProps) {
  const problem = inviteDraftProblem(draft, actorRole);
  const roles = inviteRolesFor(actorRole);
  return (
    <form
      className="st-stack"
      aria-label="Create an invite"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && problem === null) onSubmit();
      }}
    >
      <div className="st-team-fields">
        <Field label="Role">
          <select
            className="st-select"
            value={draft.teamRole}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "member" || v === "viewer" || v === "admin") onChange({ ...draft, teamRole: v });
            }}
          >
            {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Max mode">
          <select
            className="st-select"
            value={draft.maxMode}
            onChange={(e) => {
              const v = e.target.value;
              if (isMaxMode(v)) onChange({ ...draft, maxMode: v });
            }}
          >
            {MAX_MODES.map((m) => <option key={m} value={m}>{maxModeLabel(m)}</option>)}
          </select>
        </Field>
        <Field label="Monthly USD cap" hint="0 means no cap.">
          <input
            className="st-input"
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_USD_CAP_MONTH}
            step="0.01"
            value={draft.usdCapMonth}
            onChange={(e) => onChange({ ...draft, usdCapMonth: e.target.value })}
          />
        </Field>
        <Field label="Expires in hours" hint={`1 to ${MAX_INVITE_TTL_HOURS} hours (one week).`}>
          <input
            className="st-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_INVITE_TTL_HOURS}
            step="1"
            value={draft.ttlHours}
            onChange={(e) => onChange({ ...draft, ttlHours: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Email (optional)" hint="Leave empty to let any address use it; a bound invite only works for that address.">
        <input
          className="st-input"
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={draft.email}
          onChange={(e) => onChange({ ...draft, email: e.target.value })}
        />
      </Field>
      {problem ? <p className="st-error" role="alert">{problem}</p> : null}
      <div className="st-row">
        <Button tone="primary" disabled={busy || problem !== null} onClick={onSubmit}>Create invite</Button>
      </div>
    </form>
  );
}

export interface InviteTokenProps {
  created: CreatedInvite;
  copied: boolean;
  copyFailed: boolean;
  onCopy: () => void;
  onDismiss: () => void;
}

/** The single-use token. The container shows this only right after minting and drops it on dismiss/revoke. */
export function InviteTokenView({ created, copied, copyFailed, onCopy, onDismiss }: InviteTokenProps) {
  return (
    <div className="st-note" role="region" aria-label="New invite token">
      <p className="st-warning" role="alert">{TOKEN_ONCE_WARNING}</p>
      <code className="st-token">{created.token}</code>
      <div className="st-row">
        <Button tone="primary" onClick={onCopy}>Copy token</Button>
        <Button onClick={onDismiss}>Done</Button>
      </div>
      {copied ? <p className="st-hint" role="status">Copied to the clipboard.</p> : null}
      {copyFailed ? <p className="st-error" role="alert">Could not copy. Select the token above and copy it by hand.</p> : null}
      <p className="st-hint">Expires {dbTimeLabel(created.expiresAt)}. The invitee registers with this token; it works once.</p>
    </div>
  );
}

export interface InviteRowProps {
  invite: TeamInvite;
  /** Passed in by the container so an S-1 render is deterministic; never a timer. */
  nowMs: number;
  confirming: boolean;
  busy: boolean;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
}

export function InviteRowView({ invite, nowMs, confirming, busy, onAskRevoke, onCancelRevoke, onRevoke }: InviteRowProps) {
  const state = inviteState(invite, nowMs);
  const target = invite.email ?? "any email";
  return (
    <li className="st-team-row" role="listitem">
      <div className="st-item-text">
        <strong>{invite.email ?? "Any email"}</strong>
        <span className="st-hint">
          {roleLabel(invite.teamRole)} · {maxModeLabel(invite.maxMode)} · {formatUsdCap(invite.usdCapMonth)}
        </span>
        <span className="st-hint">
          {state === "used"
            ? `Used ${dbTimeLabel(invite.usedAt ?? invite.expiresAt)}`
            : state === "expired"
              ? `Expired ${dbTimeLabel(invite.expiresAt)}`
              : `Expires ${dbTimeLabel(invite.expiresAt)}`}
        </span>
      </div>
      {state === "used" ? null : confirming ? (
        <div className="st-row" role="group" aria-label={`Revoke invite for ${target}`}>
          <span className="st-hint">Revoke it? The link stops working.</span>
          <Button tone="danger" disabled={busy} onClick={onRevoke}>Revoke</Button>
          <Button onClick={onCancelRevoke} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <Button tone="danger" onClick={onAskRevoke} label={`Revoke invite for ${target}`}>Revoke</Button>
      )}
    </li>
  );
}
