import React from 'react';
import { RemoteSession } from '../hooks/useRemoteSessions';

interface Props {
  sessions: RemoteSession[];
  onJoin: (session: RemoteSession) => void;
  onDismiss: () => void;
}

export default function RemoteSessionBanner({ sessions, onJoin, onDismiss }: Props) {
  if (sessions.length === 0) return null;

  const session = sessions[0];
  const title = session.meetingTitle || 'Untitled Meeting';

  return (
    <div className="remote-session-banner">
      <div className="banner-content">
        <span className="banner-icon" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
        <div className="banner-text">
          <div className="banner-title">Live meeting detected</div>
          <div className="banner-subtitle">
            Join <strong>{title}</strong> from another device
          </div>
        </div>
      </div>
      <div className="banner-actions">
        <button className="btn btn-sm btn-primary" onClick={() => onJoin(session)}>
          Join
        </button>
        <button className="btn btn-sm btn-ghost btn-icon" onClick={onDismiss} aria-label="Dismiss">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
