/**
 * Export format registry.
 *
 * Each format describes how to produce a downloadable file from
 * transcript data.  The ExportMenu component iterates this registry
 * instead of hard-coding each format inline.
 *
 * To add a new export format:
 *   1. Add an entry to EXPORT_FORMATS below.
 *   2. That's it — the UI picks it up automatically.
 */

import type { TranscriptSegment } from '../sidepanel/hooks/useTranscript';

// ── Types ────────────────────────────────────────────────────────────

export interface ExportContext {
  transcript: string;
  notes: string;
  meetingTitle: string;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  language?: string;
  dateStr: string;
}

interface ExportFormat {
  /** Unique key for React keys and settings. */
  id: string;
  /** Button label shown in the UI. */
  label: string;
  /** Accessible description of the export. */
  ariaLabel: string;
  /** MIME type for the Blob. */
  mimeType: string;
  /** Generate the filename (without path). */
  filename: (ctx: ExportContext) => string;
  /** Generate the file content as a string. */
  build: (ctx: ExportContext) => string;
  /** Whether this format requires transcript segments (not just plain text). */
  requiresSegments?: boolean;
  /** Whether this format exports notes (vs transcript). */
  source: 'transcript' | 'notes';
}

// ── Helpers ──────────────────────────────────────────────────────────

function subtitleTimestamp(ms: number, sep: ',' | '.'): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ml = totalMs % 1000;
  return (
    `${String(h).padStart(2, '0')}:` +
    `${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}${sep}` +
    `${String(ml).padStart(3, '0')}`
  );
}

function buildSubtitleContent(
  segments: TranscriptSegment[],
  speakerNames: Record<string, string>,
  format: 'vtt' | 'srt',
): string {
  if (segments.length === 0) return '';
  const startEpoch = segments[0].timestamp;
  const sep = format === 'srt' ? ',' : '.';
  const lines: string[] = [];
  if (format === 'vtt') lines.push('WEBVTT', '');
  segments.forEach((seg, i) => {
    const cueStart = Math.max(0, seg.timestamp - startEpoch);
    const next = segments[i + 1];
    const cueEnd = next
      ? Math.max(cueStart + 500, next.timestamp - startEpoch)
      : cueStart + 3000;
    if (format === 'srt') lines.push(String(i + 1));
    lines.push(`${subtitleTimestamp(cueStart, sep)} --> ${subtitleTimestamp(cueEnd, sep)}`);
    const name = speakerNames[seg.speaker] || seg.speaker;
    const text = seg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    lines.push(`${name}: ${text}`, '');
  });
  return lines.join('\n');
}

// ── Registry ─────────────────────────────────────────────────────────

const EXPORT_FORMATS: readonly ExportFormat[] = [
  {
    id: 'notes-md',
    label: 'Download .md',
    ariaLabel: 'Download notes as Markdown file',
    mimeType: 'text/markdown',
    source: 'notes',
    filename: (ctx) => `meeting-notes-${ctx.dateStr}.md`,
    build: (ctx) => ctx.notes,
  },
  {
    id: 'transcript-txt',
    label: 'Download .txt',
    ariaLabel: 'Download transcript as text file',
    mimeType: 'text/plain',
    source: 'transcript',
    filename: (ctx) => `transcript-${ctx.dateStr}.txt`,
    build: (ctx) => ctx.transcript,
  },
  {
    id: 'transcript-vtt',
    label: 'Download .vtt',
    ariaLabel: 'Download transcript as WebVTT subtitle file',
    mimeType: 'text/vtt',
    source: 'transcript',
    requiresSegments: true,
    filename: (ctx) => `transcript-${ctx.dateStr}.vtt`,
    build: (ctx) => buildSubtitleContent(ctx.segments, ctx.speakerNames, 'vtt'),
  },
  {
    id: 'transcript-srt',
    label: 'Download .srt',
    ariaLabel: 'Download transcript as SubRip subtitle file',
    mimeType: 'application/x-subrip',
    source: 'transcript',
    requiresSegments: true,
    filename: (ctx) => `transcript-${ctx.dateStr}.srt`,
    build: (ctx) => buildSubtitleContent(ctx.segments, ctx.speakerNames, 'srt'),
  },
  {
    id: 'transcript-json',
    label: 'Download .json',
    ariaLabel: 'Download transcript as structured JSON',
    mimeType: 'application/json',
    source: 'transcript',
    requiresSegments: true,
    filename: (ctx) => `transcript-${ctx.dateStr}.json`,
    build: (ctx) =>
      JSON.stringify(
        {
          meetingTitle: ctx.meetingTitle,
          date: ctx.dateStr,
          language: ctx.language,
          segments: ctx.segments.map((seg) => ({
            speaker: ctx.speakerNames[seg.speaker] || seg.speaker,
            text: seg.text,
            timestamp: seg.timestamp,
            lang: seg.lang,
          })),
        },
        null,
        2,
      ),
  },
] as const;

/**
 * Get export formats applicable to the current data.
 * Filters out formats that require segments when none are available,
 * and formats whose source data (notes/transcript) is empty.
 */
export function getAvailableFormats(ctx: ExportContext): ExportFormat[] {
  return EXPORT_FORMATS.filter((fmt) => {
    if (fmt.source === 'notes' && !ctx.notes) return false;
    if (fmt.source === 'transcript' && !ctx.transcript) return false;
    if (fmt.requiresSegments && ctx.segments.length === 0) return false;
    return true;
  });
}
