// Settings → Team (ADR 0021 H2 local/UI part, API 123): team members and their single-use invites.
// The group is shown by SettingsScreen only to an owner or admin (`/auth/me.member.teamRole`); this
// container re-checks the same role before it calls any admin route. The invite token lives in React
// state only: it is never logged, persisted or put in localStorage, and it disappears on Done/revoke.
import { useState } from "react";
import { call } from "../core-api.ts";
import { describeError } from "../errors.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import {
  buildInviteBody, buildMemberPatch, canManageTeam, createTeamInvite, decodeTeamIdentity,
  defaultInviteDraft, defaultMemberDraft, inviteDraftProblem, listTeamInvites, listTeamMembers,
  memberDraftProblem, patchTeamMember, revokeTeamInvite, roleLabel, teamRoleFromMe,
  type CreatedInvite, type InviteDraft, type MemberDraft, type TeamInvite, type TeamMember, type TeamRole,
} from "../team-model.ts";
import {
  InviteFormView, InviteRowView, InviteTokenView, MemberEditorView, MemberRowView, TeamAccessNotice,
} from "./team-view.tsx";

type Gate =
  | { kind: "checking" }
  | { kind: "forbidden"; teamRole: TeamRole | null }
  | { kind: "error"; message: string }
  | { kind: "ready"; selfId: string; actorRole: TeamRole };

export default function TeamSection() {
  const { client, host } = useEnv();
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invites, setInvites] = useState<TeamInvite[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memberDraft, setMemberDraft] = useState<MemberDraft | null>(null);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(defaultInviteDraft);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const loadLists = async (): Promise<void> => {
    try {
      const [nextMembers, nextInvites] = await Promise.all([listTeamMembers(client), listTeamInvites(client)]);
      setMembers(nextMembers);
      setInvites(nextInvites);
      setListError(null);
    } catch (e) {
      setListError(describeError(e));
    }
  };

  // The gate reads the enforced team role, never `users.role` and never the JWT claim.
  const load = async (): Promise<void> => {
    let body: unknown;
    try {
      body = await call(client, "GET", "/auth/me");
    } catch (e) {
      setGate({ kind: "error", message: describeError(e) });
      return;
    }
    const identity = decodeTeamIdentity(body);
    if (!identity || !canManageTeam(identity.teamRole)) {
      setMembers(null);
      setInvites(null);
      setGate({ kind: "forbidden", teamRole: teamRoleFromMe(body) });
      return;
    }
    setGate({ kind: "ready", selfId: identity.id, actorRole: identity.teamRole });
    await loadLists();
  };

  useRefreshOnFocus(() => {
    void load();
  });

  const startEdit = (member: TeamMember): void => {
    setEditingId(member.userId);
    setMemberDraft(defaultMemberDraft(member));
    setActionError(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setMemberDraft(null);
  };

  const saveMember = async (): Promise<void> => {
    if (gate.kind !== "ready" || editingId === null || memberDraft === null || busy) return;
    const member = members?.find((m) => m.userId === editingId);
    if (!member) return;
    const problem = memberDraftProblem(member, memberDraft, gate.actorRole, gate.selfId);
    if (problem !== null) {
      setActionError(problem);
      return;
    }
    const patch = buildMemberPatch(member, memberDraft);
    if (patch === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await patchTeamMember(client, member.userId, patch);
      // Show the server's answer at once, then refresh the list so ordering and other rows are authoritative.
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === updated.userId ? updated : m)) : prev));
      cancelEdit();
      void loadLists();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async (): Promise<void> => {
    if (gate.kind !== "ready" || busy) return;
    const problem = inviteDraftProblem(inviteDraft, gate.actorRole);
    if (problem !== null) {
      setActionError(problem);
      return;
    }
    const body = buildInviteBody(inviteDraft, gate.actorRole);
    if (body === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const made = await createTeamInvite(client, body);
      setCreated(made);
      setCopied(false);
      setCopyFailed(false);
      setInviteDraft(defaultInviteDraft());
      void loadLists();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async (): Promise<void> => {
    if (!created) return;
    try {
      await host.copyText(created.token);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const dismissToken = (): void => {
    setCreated(null);
    setCopied(false);
    setCopyFailed(false);
  };

  const revoke = async (id: string): Promise<void> => {
    if (gate.kind !== "ready" || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await revokeTeamInvite(client, id);
      setInvites((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
      if (created?.id === id) dismissToken();
      setConfirmRevoke(null);
      void loadLists();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (gate.kind === "checking") return <p className="st-hint" role="status">Checking your team role…</p>;
  if (gate.kind === "forbidden") return <TeamAccessNotice teamRole={gate.teamRole} />;
  if (gate.kind === "error") {
    return (
      <div className="st-stack">
        <ErrorText text={gate.message} />
        <div className="st-row"><Button onClick={() => void load()}>Retry</Button></div>
      </div>
    );
  }

  return (
    <div className="st-stack">
      <div className="st-row">
        <p className="st-hint st-grow">
          Signed in as {roleLabel(gate.actorRole)}. Changes apply on the member&apos;s next request. An admin cannot change an
          owner, and nobody can change their own role or grants.
        </p>
        <Button onClick={() => void load()} disabled={busy}>Refresh</Button>
      </div>
      <ErrorText text={actionError} />
      {listError ? (
        <div className="st-stack">
          <ErrorText text={listError} />
          <div className="st-row"><Button onClick={() => void load()}>Retry</Button></div>
        </div>
      ) : null}

      <section className="st-stack" aria-label="Members">
        <p className="st-label">Members</p>
        {members === null ? (
          <p className="st-hint" role="status">Loading team members…</p>
        ) : members.length === 0 ? (
          <p className="st-hint">No members yet.</p>
        ) : (
          <ul className="st-team-list" aria-label="Team members">
            {members.map((m) =>
              editingId === m.userId && memberDraft !== null ? (
                <MemberEditorView
                  key={m.userId}
                  member={m}
                  actorRole={gate.actorRole}
                  selfId={gate.selfId}
                  draft={memberDraft}
                  onChange={setMemberDraft}
                  onSave={() => void saveMember()}
                  onCancel={cancelEdit}
                  busy={busy}
                />
              ) : (
                <MemberRowView key={m.userId} member={m} actorRole={gate.actorRole} selfId={gate.selfId} onEdit={() => startEdit(m)} />
              ),
            )}
          </ul>
        )}
      </section>

      <hr className="st-rule" />

      <section className="st-stack" aria-label="Invites">
        <p className="st-label">Invites</p>
        {created ? (
          <InviteTokenView
            created={created}
            copied={copied}
            copyFailed={copyFailed}
            onCopy={() => void copyToken()}
            onDismiss={dismissToken}
          />
        ) : null}
        <InviteFormView
          actorRole={gate.actorRole}
          draft={inviteDraft}
          onChange={setInviteDraft}
          onSubmit={() => void createInvite()}
          busy={busy}
        />
        {invites === null ? (
          <p className="st-hint" role="status">Loading invites…</p>
        ) : invites.length === 0 ? (
          <p className="st-hint">No invites yet.</p>
        ) : (
          <ul className="st-team-list" aria-label="Invites">
            {invites.map((i) => (
              <InviteRowView
                key={i.id}
                invite={i}
                nowMs={Date.now()}
                confirming={confirmRevoke === i.id}
                busy={busy}
                onAskRevoke={() => setConfirmRevoke(i.id)}
                onCancelRevoke={() => setConfirmRevoke(null)}
                onRevoke={() => void revoke(i.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
