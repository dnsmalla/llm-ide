import React, { useState, useMemo } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';
import { getAvailableFormats, type ExportContext } from '../../lib/export-formats';
import type { TranscriptSegment } from '../hooks/useTranscript';

interface Props {
  transcript: string;
  notes: string;
  meetingTitle?: string;
  segments?: TranscriptSegment[];
  speakerNames?: Record<string, string>;
  language?: string;
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export default function ExportMenu({
  transcript,
  notes,
  meetingTitle = '',
  segments = [],
  speakerNames = {},
  language,
}: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const dateStr = todayStr();

  const ctx = useMemo<ExportContext>(
    () => ({ transcript, notes, meetingTitle, segments, speakerNames, language, dateStr }),
    [transcript, notes, meetingTitle, segments, speakerNames, language, dateStr],
  );

  const formats = useMemo(() => getAvailableFormats(ctx), [ctx]);

  if (!transcript && !notes) return null;

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`Copied ${label}`);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setExportError('Failed to copy to clipboard');
    }
  };

  const downloadFormat = (formatId: string) => {
    const fmt = formats.find((f) => f.id === formatId);
    if (!fmt) return;
    const content = fmt.build(ctx);
    const blob = new Blob([content], { type: fmt.mimeType });
    const url = URL.createObjectURL(blob);
    try {
      triggerDownload(url, fmt.filename(ctx));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const downloadDocx = async () => {
    if (!transcript || isExporting) return;
    setIsExporting(true);
    setExportError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let blobUrl: string | null = null;

    try {
      const serverUrl = await getServerUrl();
      const response = await authFetch(`${serverUrl}/generate-docx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, meetingTitle, language }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Server error: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to generate DOCX');
      }

      const blob = await response.blob();
      blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, `meeting-notes-${dateStr}.docx`);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setExportError('DOCX generation timed out. Try again.');
      } else {
        setExportError(err instanceof Error ? err.message : 'Failed to generate DOCX');
      }
    } finally {
      clearTimeout(timeout);
      setIsExporting(false);
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 1000);
    }
  };

  // Split formats by source for grouped rendering.
  const noteFormats = formats.filter((f) => f.source === 'notes');
  const transcriptFormats = formats.filter((f) => f.source === 'transcript');

  return (
    <div className="export-menu">
      {transcript && (
        <button
          className="btn btn-docx"
          onClick={downloadDocx}
          disabled={isExporting}
          aria-label={isExporting ? 'Generating DOCX file' : 'Download as Word document'}
        >
          {isExporting ? 'Generating…' : 'Download DOCX'}
        </button>
      )}

      {exportError && (
        <div className="error-message" role="alert">
          {exportError}
        </div>
      )}
      {copyFeedback && (
        <div className="success-message" role="status">
          {copyFeedback}
        </div>
      )}

      <div className="export-actions">
        {notes && (
          <button
            className="btn btn-sm"
            onClick={() => copyToClipboard(notes, 'notes')}
            aria-label="Copy notes to clipboard"
          >
            Copy Notes
          </button>
        )}
        {noteFormats.map((fmt) => (
          <button key={fmt.id} className="btn btn-sm" onClick={() => downloadFormat(fmt.id)} aria-label={fmt.ariaLabel}>
            {fmt.label}
          </button>
        ))}
        {transcript && (
          <button
            className="btn btn-sm"
            onClick={() => copyToClipboard(transcript, 'transcript')}
            aria-label="Copy transcript to clipboard"
          >
            Copy Transcript
          </button>
        )}
        {transcriptFormats.map((fmt) => (
          <button key={fmt.id} className="btn btn-sm" onClick={() => downloadFormat(fmt.id)} aria-label={fmt.ariaLabel}>
            {fmt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
