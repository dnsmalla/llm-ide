import { useState, useCallback, useEffect, useRef } from 'react';
import { generateMeetingNotesStream } from '../../lib/anthropic';

export function useNotes() {
  const [notes, setNotes] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Accumulator ref for streaming chunks — we batch updates to avoid
  // re-rendering on every single token (which would thrash React and
  // cause visible jank on fast streams). The ref holds the latest
  // accumulated text; a rAF loop flushes it to state at ~60fps.
  const accRef = useRef('');
  const rafRef = useRef<number | null>(null);
  // Track the last-flushed length so we only call setNotes when new
  // chunks have actually arrived — avoids re-rendering every frame
  // when the stream is idle between tokens.
  const flushedLenRef = useRef(0);

  const generate = useCallback(
    async (transcript: string, meetingTitle?: string, participants?: string[], language?: string) => {
      if (!transcript.trim()) {
        setError('No transcript available. Record a meeting first.');
        return;
      }
      if (isGenerating) return;

      setIsGenerating(true);
      setError(null);
      setNotes('');
      accRef.current = '';
      flushedLenRef.current = 0;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // rAF loop that flushes accumulated chunks to React state.
      // Only calls setNotes when new data has arrived since the last
      // flush, so idle frames don't trigger re-renders.
      let flushing = true;
      const flush = () => {
        if (!flushing) return;
        if (accRef.current.length > flushedLenRef.current) {
          flushedLenRef.current = accRef.current.length;
          setNotes(accRef.current);
        }
        rafRef.current = requestAnimationFrame(flush);
      };
      rafRef.current = requestAnimationFrame(flush);

      try {
        const result = await generateMeetingNotesStream(
          transcript,
          (chunk: string) => {
            accRef.current += chunk;
          },
          meetingTitle,
          participants,
          controller.signal,
          language,
        );
        if (controller.signal.aborted) return;
        // Final state — ensure we have the complete text, not a
        // rAF-lagged partial snapshot.
        setNotes(result);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to generate notes');
      } finally {
        flushing = false;
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (abortRef.current === controller) abortRef.current = null;
        setIsGenerating(false);
      }
    },
    [isGenerating],
  );

  const clearNotes = useCallback(() => {
    abortRef.current?.abort();
    setNotes('');
    setError(null);
    setIsGenerating(false);
    accRef.current = '';
  }, []);

  // Abort any in-flight generation when the hook unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return { notes, isGenerating, error, generate, clearNotes };
}
