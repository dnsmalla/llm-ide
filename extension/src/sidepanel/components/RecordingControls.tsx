import React from 'react';

interface Props {
  isRecording: boolean;
  isMirroring?: boolean;
  elapsed: number;
  onStart: () => void;
  onStop: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function RecordingControls({ isRecording, isMirroring, elapsed, onStart, onStop }: Props) {
  const active = isRecording || isMirroring;
  const label = isMirroring ? 'Mirroring' : 'Recording';

  return (
    <div className="recording-controls">
      {active ? (
        <>
          <div className="recording-indicator" role="status" aria-live="polite">
            <span className={`recording-dot ${isMirroring ? 'mirroring' : ''}`} aria-hidden="true" />
            <span
              className="recording-time"
              aria-label={`${label} ${!isMirroring ? 'for ' + formatTime(elapsed) : ''}`}
            >
              {isMirroring ? 'Mirroring' : formatTime(elapsed)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-stop"
            onClick={onStop}
            aria-label={isMirroring ? 'Stop mirroring' : 'Stop recording'}
          >
            {isMirroring ? 'Stop Mirroring' : 'Stop Recording'}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-start" onClick={onStart} aria-label="Start recording">
          Start Recording
        </button>
      )}
    </div>
  );
}
