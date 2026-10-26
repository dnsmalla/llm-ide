import type { Cancel, OsState } from '../types';
import { fmtInt, fmtTime } from '../format';
import { Card, Empty } from './common';

type Running = OsState['running'];

function Row({
  title,
  detail,
  cancel,
  stopKey,
  stopping,
  onStop,
}: {
  title: string;
  detail: string;
  cancel: Cancel;
  stopKey: string;
  stopping: string | null;
  onStop: (cancel: Cancel, key: string) => void;
}) {
  const busy = stopping === stopKey;
  return (
    <li className="row">
      <div className="row-main">
        <strong>{title}</strong>
        <div className="meta">{detail}</div>
      </div>
      {cancel ? (
        <button
          type="button"
          className="btn btn-danger"
          aria-label={`Stop ${title.toLowerCase()}`}
          disabled={stopping !== null}
          onClick={() => onStop(cancel, stopKey)}
        >
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      ) : (
        <span className="meta">Stop it in the Mac app</span>
      )}
    </li>
  );
}

export function RunningNow({
  running,
  stopping,
  onStop,
}: {
  running: Running;
  stopping: string | null;
  onStop: (cancel: Cancel, key: string) => void;
}) {
  const total = running.chatTurns.length + running.meetingAgentRuns.length + running.liveSessions.length;
  return (
    <Card id="sec-running" title="Running now">
      {total === 0 ? (
        <Empty>Nothing is running. Chat turns, meeting agents and live captures appear here while they work.</Empty>
      ) : (
        <ul className="rows">
          {running.chatTurns.map((turn) => (
            <Row
              key={`chat-${turn.chatSessionId}`}
              title="Chat turn"
              detail={`Started ${fmtTime(turn.startedAt)} · session ${turn.chatSessionId}`}
              cancel={turn.cancel}
              stopKey={`chat-${turn.chatSessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
          {running.meetingAgentRuns.map((run) => (
            <Row
              key={`agent-${run.sessionId}`}
              title="Meeting agent"
              detail={`Started ${fmtTime(run.startedAt)}${run.planId ? ` · plan ${run.planId}` : ''}`}
              cancel={run.cancel}
              stopKey={`agent-${run.sessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
          {running.liveSessions.map((session) => (
            <Row
              key={`live-${session.sessionId}`}
              title="Live capture"
              detail={`${session.meetingTitle ?? 'Untitled meeting'} · ${fmtInt(session.captionCount)} captions · last ${fmtTime(session.lastWrite)}`}
              cancel={session.cancel}
              stopKey={`live-${session.sessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
