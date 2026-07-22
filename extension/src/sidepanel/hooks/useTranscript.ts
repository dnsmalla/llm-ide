import { useState, useEffect, useCallback, useRef } from 'react';
import { MsgType, isMessage } from '../../lib/messages';
import { debug } from '../../lib/config';
import { saveTranscript as persistTranscript, StorageQuotaError } from '../../lib/storage';
import { isSupportedUrl, stripPlatformSuffix } from '../../lib/platforms';

export interface TranscriptSegment {
  text: string;
  timestamp: number;
  isFinal: boolean;
  speaker: string;
  lang?: string;
  sessionId?: string; // For CC mode: groups updates of the same utterance
}

export const LANGUAGES = [
  { code: 'ja', label: 'Japanese' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ne-NP', label: 'Nepali' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt-BR', label: 'Portuguese (BR)' },
  { code: 'it', label: 'Italian' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'tl', label: 'Filipino' },
] as const;

export interface TranscriptOptions {
  deviceId?: string;
  volume?: number;
}

const SILENCE_THRESHOLD_MS = 2000;
const MAX_SEGMENTS = 5000;

type CaptureMode = 'captions' | 'mic';

interface PendingResult {
  text: string;
  confidence: number;
  lang: string;
}

// Strip trailing platform suffix from a browser tab title and cap to 120 chars.
// Delegates to the centralized platforms registry.
function extractMeetingTitle(raw: string): string {
  return stripPlatformSuffix(raw).slice(0, 120);
}

export interface Diagnostics {
  platform: string | null; // last platform reported by a content script
  captionsReceived: number; // total CAPTION_FINAL messages this session
  lastCaptionAt: number; // epoch ms of the most recent caption
}

export function useTranscript() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [primaryLang, setPrimaryLang] = useState('ja');
  const [secondaryLang, setSecondaryLang] = useState('en-US');
  const [bilingual, setBilingual] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [participants, setParticipants] = useState<string[]>([]);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('mic');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    platform: null,
    captionsReceived: 0,
    lastCaptionAt: 0,
  });
  const [segmentLimitReached, setSegmentLimitReached] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const primaryRecRef = useRef<SpeechRecognition | null>(null);
  const secondaryRecRef = useRef<SpeechRecognition | null>(null);
  const startTimeRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const activeSpeakerRef = useRef<string | null>(null);
  const currentSpeakerNumRef = useRef(1);
  const lastSpeechEndRef = useRef(0);
  const isRecordingRef = useRef(false);
  const pendingResultsRef = useRef<Map<number, PendingResult[]>>(new Map());
  const resultCounterRef = useRef(0);
  const captureModeRef = useRef<CaptureMode>('mic');
  const restartTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Tracks the 0s/1s/3s START retry timers so they can be cancelled in stopRecording.
  const startRetryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Snapshot refs so stopRecording() can persist the transcript without
  // adding state values to its dep array (which would recreate the
  // listener on every caption update).
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const speakerNamesRef = useRef<Record<string, string>>({});
  const meetingTitleRef = useRef('');
  const elapsedRef = useRef(0);
  const primaryLangRef = useRef('ja');
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  useEffect(() => {
    speakerNamesRef.current = speakerNames;
  }, [speakerNames]);
  useEffect(() => {
    meetingTitleRef.current = meetingTitle;
  }, [meetingTitle]);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);
  useEffect(() => {
    primaryLangRef.current = primaryLang;
  }, [primaryLang]);

  // Keep refs in sync with state.  These refs are read from the
  // chrome.runtime.onMessage listener (registered once, stale-closure
  // otherwise).  We also update them EAGERLY from the setters below so a
  // CAPTION_FINAL arriving in the same tick as start/stop isn't dropped.
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  useEffect(() => {
    captureModeRef.current = captureMode;
  }, [captureMode]);

  const setRecordingSync = useCallback((recording: boolean, mode?: CaptureMode) => {
    isRecordingRef.current = recording;
    if (mode) captureModeRef.current = mode;
    setIsRecording(recording);
    if (mode) setCaptureMode(mode);
  }, []);

  // Load preferences
  useEffect(() => {
    chrome.storage?.local
      ?.get(['primaryLang', 'secondaryLang', 'bilingual', 'speakerNames'])
      .then(
        (
          result: {
            primaryLang?: string;
            secondaryLang?: string;
            bilingual?: boolean;
            speakerNames?: Record<string, string>;
          },
        ) => {
          if (result.primaryLang) setPrimaryLang(result.primaryLang);
          if (result.secondaryLang) setSecondaryLang(result.secondaryLang);
          if (result.bilingual !== undefined) setBilingual(result.bilingual);
          if (result.speakerNames) setSpeakerNames(result.speakerNames);
        },
      )
      .catch(() => {});
  }, []);

  // If this app instance opened AFTER recording had already begun (user
  // popped out the side panel into a floating window), ask the active
  // tab's caption scraper for its current state.  The scraper replies with
  // a CAPTION_STATUS broadcast which our listener below picks up.
  useEffect(() => {
    chrome.tabs
      ?.query?.({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, { type: MsgType.GET_CAPTION_STATUS }).catch(() => {});
      })
      .catch(() => {});
  }, []);

  // Listen for messages from content scripts
  useEffect(() => {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      // Only trust messages from our own extension's contexts (content
      // scripts, service worker) — see the matching guard in
      // service-worker.ts / caption-scraper.ts / speaker-detector.ts.
      // Without this, another installed extension could forge
      // CAPTION_FINAL/CAPTION_STATUS messages into this side panel.
      if (sender.id !== chrome.runtime.id) return;
      if (!isMessage(message)) return;

      if (message.type === MsgType.ACTIVE_SPEAKER) {
        activeSpeakerRef.current = message.speaker;
        return;
      }

      if (message.type === MsgType.PARTICIPANTS_LIST) {
        // Merge: keep any speakers already added via captions (e.g. Agent/bots
        // with no video tile that getMeetParticipants() never sees).
        setParticipants((prev) => {
          const union = [...prev];
          for (const p of message.participants) {
            if (!union.includes(p)) union.push(p);
          }
          return union;
        });
        return;
      }

      if (message.type === MsgType.CAPTION_STATUS) {
        debug('CC status', message.platform, 'active=', message.active);
        setDiagnostics((d) => ({ ...d, platform: message.platform }));
        // Cross-context state sync.  Whichever app instance (side panel or
        // floating popup) kicked recording off, every other instance picks
        // it up from this broadcast — so captions aren't dropped in a
        // window that never called startRecording() itself.
        if (message.active) {
          setRecordingSync(true, 'captions');
        } else {
          setRecordingSync(false);
          setInterimText('');
        }
        return;
      }

      if (message.type === MsgType.CAPTION_SCRAPER_READY) {
        setDiagnostics((d) => ({ ...d, platform: message.platform }));
        return;
      }

      // Caption data from caption-scraper (Meet/Teams/Zoom CC).
      // The scraper groups each speaker's continuous utterance into a sessionId.
      // We keep ONE transcript line per session, updating it as the caption grows.
      if (message.type === MsgType.CAPTION_FINAL && isRecordingRef.current && captureModeRef.current === 'captions') {
        const { speaker, text, timestamp, sessionId } = message;
        const safeName = speaker.trim().slice(0, 50) || 'Unknown';

        setDiagnostics((d) => ({
          ...d,
          captionsReceived: d.captionsReceived + 1,
          lastCaptionAt: timestamp,
        }));

        setSegments((prev) => {
          // Scan back for an existing segment with the same sessionId so
          // out-of-order or interleaved speakers are merged correctly.
          // (findLastIndex is ES2023; scan manually for ES2020 compat.)
          let existingIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].sessionId === sessionId) {
              existingIdx = i;
              break;
            }
          }
          if (existingIdx !== -1) {
            if (prev[existingIdx].text === text) return prev;
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx], text, timestamp };
            return updated;
          }
          // Add the caption speaker to participants if not already present.
          // This ensures bots/agents (e.g. "Agent") with no video tile show
          // up in the contributors list even though getMeetParticipants()
          // only scrapes [data-self-name] from video grid tiles.
          setParticipants((pp) => (pp.includes(safeName) ? pp : [...pp, safeName]));
          const next = [
            ...prev,
            {
              text,
              timestamp,
              isFinal: true,
              speaker: safeName,
              sessionId,
            },
          ];
          if (next.length > MAX_SEGMENTS) {
            setSegmentLimitReached(true);
            return next.slice(-MAX_SEGMENTS);
          }
          return next;
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const changePrimaryLang = useCallback((lang: string) => {
    setPrimaryLang(lang);
    chrome.storage?.local?.set({ primaryLang: lang }).catch(() => {});
  }, []);

  const changeSecondaryLang = useCallback((lang: string) => {
    setSecondaryLang(lang);
    chrome.storage?.local?.set({ secondaryLang: lang }).catch(() => {});
  }, []);

  const toggleBilingual = useCallback((enabled: boolean) => {
    setBilingual(enabled);
    chrome.storage?.local?.set({ bilingual: enabled }).catch(() => {});
  }, []);

  const renameSpeaker = useCallback((speakerId: string, name: string) => {
    const trimmed = name.trim().slice(0, 50);
    if (!trimmed) return;
    setSpeakerNames((prev) => {
      const updated = { ...prev, [speakerId]: trimmed };
      chrome.storage?.local?.set({ speakerNames: updated }).catch(() => {});
      return updated;
    });
  }, []);

  // Timer
  useEffect(() => {
    if (!isRecording) return;
    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  // ─── Mic setup ──────────────────────────────────────────────────────

  const setupMic = useCallback(async (deviceId?: string, volume?: number) => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      if (volume && volume !== 100) {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gainNode = ctx.createGain();
        gainNode.gain.value = volume / 100;
        const dest = ctx.createMediaStreamDestination();
        source.connect(gainNode);
        gainNode.connect(dest);
        audioContextRef.current = ctx;
        // Route the gain-adjusted stream to SpeechRecognition instead of the raw stream.
        mediaStreamRef.current = dest.stream;
      }
      return true;
    } catch (err: unknown) {
      const e = err as DOMException;
      if (e.name === 'NotAllowedError') {
        setError('Microphone access denied. Please allow microphone permission.');
      } else if (e.name === 'NotFoundError') {
        setError('Selected microphone not found. Check Settings.');
      } else {
        setError(`Microphone error: ${e.message || 'Unknown error'}`);
      }
      return false;
    }
  }, []);

  const cleanupMic = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  }, []);

  // ─── Speaker detection ──────────────────────────────────────────────

  const getSpeaker = useCallback(() => {
    if (activeSpeakerRef.current) return activeSpeakerRef.current;
    const now = Date.now();
    const gap = now - lastSpeechEndRef.current;
    if (gap > SILENCE_THRESHOLD_MS && lastSpeechEndRef.current > 0) {
      currentSpeakerNumRef.current++;
    }
    lastSpeechEndRef.current = now;
    return `Speaker ${currentSpeakerNumRef.current}`;
  }, []);

  const addSegment = useCallback(
    (text: string, lang: string) => {
      const speaker = getSpeaker();
      setSegments((prev) => {
        const next = [...prev, { text, timestamp: Date.now(), isFinal: true, speaker, lang }];
        if (next.length > MAX_SEGMENTS) {
          setSegmentLimitReached(true);
          return next.slice(-MAX_SEGMENTS);
        }
        return next;
      });
      setInterimText('');
    },
    [getSpeaker],
  );

  // ─── Speech Recognition (mic mode) ─────────────────────────────────

  const stopAllRecognition = useCallback(() => {
    // Clear pending restart timers to prevent restarts after stop.
    for (const t of restartTimersRef.current) clearTimeout(t);
    restartTimersRef.current.clear();
    for (const ref of [primaryRecRef, secondaryRecRef]) {
      if (ref.current) {
        const r = ref.current;
        ref.current = null;
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.abort();
      }
    }
    pendingResultsRef.current.clear();
  }, []);

  const createRecognition = useCallback(
    (
      lang: string,
      ref: React.MutableRefObject<SpeechRecognition | null>,
      onFinalResult: (text: string, confidence: number, lang: string) => void,
      onInterimResult: (text: string) => void,
    ) => {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) {
        setError('Speech recognition not supported. Use Chrome.');
        return;
      }

      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = lang;

      rec.onresult = (event: SpeechRecognitionEvent) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript;
          const confidence = result[0].confidence;
          if (result.isFinal) {
            onFinalResult(text, confidence, lang);
          } else {
            onInterimResult(text);
          }
        }
      };

      const restart = () => {
        if (ref.current) {
          ref.current.onresult = null;
          ref.current.onerror = null;
          ref.current.onend = null;
          ref.current.abort();
          ref.current = null;
        }
        if (isRecordingRef.current && captureModeRef.current === 'mic') {
          createRecognition(lang, ref, onFinalResult, onInterimResult);
        }
      };

      const scheduleRestart = (delayMs: number) => {
        const t = setTimeout(() => {
          restartTimersRef.current.delete(t);
          restart();
        }, delayMs);
        restartTimersRef.current.add(t);
      };

      rec.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          if (isRecordingRef.current) scheduleRestart(500);
          return;
        }
        if (event.error === 'not-allowed') {
          setError('Microphone access denied.');
          setIsRecording(false);
          return;
        }
        if (ref === primaryRecRef) {
          setError(`Speech recognition error: ${event.error}`);
        }
      };

      rec.onend = () => {
        if (isRecordingRef.current && captureModeRef.current === 'mic') {
          scheduleRestart(300);
        }
      };

      ref.current = rec;
      rec.start();
    },
    [],
  );

  // Bilingual: compare results from two instances
  const startBilingualRecognition = useCallback(
    (lang1: string, lang2: string) => {
      const COMPARE_WINDOW_MS = 1500;

      const handleFinal = (text: string, confidence: number, lang: string) => {
        const roundId = resultCounterRef.current;
        const existing = pendingResultsRef.current.get(roundId) || [];
        existing.push({ text, confidence, lang });
        pendingResultsRef.current.set(roundId, existing);

        if (existing.length >= 2) {
          pickBest(roundId);
          resultCounterRef.current++;
          return;
        }

        setTimeout(() => {
          if (pendingResultsRef.current.has(roundId)) {
            pickBest(roundId);
            resultCounterRef.current++;
          }
        }, COMPARE_WINDOW_MS);
      };

      const pickBest = (roundId: number) => {
        const results = pendingResultsRef.current.get(roundId);
        pendingResultsRef.current.delete(roundId);
        if (!results?.length) return;

        let best = results[0];
        if (results.length >= 2) {
          const primary = results.find((r) => r.lang === lang1);
          const secondary = results.find((r) => r.lang === lang2);
          if (primary && secondary) {
            best = secondary.confidence - primary.confidence > 0.15 ? secondary : primary;
          }
        }
        addSegment(best.text, best.lang);
      };

      const handleInterim = (text: string) => setInterimText(text);

      createRecognition(lang1, primaryRecRef, handleFinal, handleInterim);
      createRecognition(lang2, secondaryRecRef, handleFinal, handleInterim);
    },
    [createRecognition, addSegment],
  );

  const startSingleRecognition = useCallback(
    (lang: string) => {
      createRecognition(
        lang,
        primaryRecRef,
        (text, _conf, langCode) => addSegment(text, langCode),
        (text) => setInterimText(text),
      );
    },
    [createRecognition, addSegment],
  );

  // ─── Public API ─────────────────────────────────────────────────────

  const startRecording = useCallback(
    async (options?: TranscriptOptions) => {
      setError(null);
      setSegments([]);
      setInterimText('');
      setElapsed(0);
      setSegmentLimitReached(false);
      setSaveError(null);
      currentSpeakerNumRef.current = 1;
      lastSpeechEndRef.current = 0;
      activeSpeakerRef.current = null;
      resultCounterRef.current = 0;
      pendingResultsRef.current.clear();

      // Check if we're on a supported platform with CC captions
      let useCaptions = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url || '';
        // Capture the tab title as the meeting title — falls back to empty if
        // the tab is the extension's own popup window.
        if (tab?.title) setMeetingTitle(extractMeetingTitle(tab.title));

        if (isSupportedUrl(url)) {
          // Tell caption scraper to start — retry in case content script hasn't loaded yet.
          // Clear any previously-scheduled retries before scheduling fresh ones so a
          // rapid Stop→Start sequence doesn't deliver a stale START after a STOP.
          for (const t of startRetryTimersRef.current) clearTimeout(t);
          startRetryTimersRef.current = [];
          const sendStart = () => chrome.runtime.sendMessage({ type: MsgType.START_CAPTION_SCRAPING }).catch(() => {});
          sendStart();
          startRetryTimersRef.current.push(setTimeout(sendStart, 1000));
          startRetryTimersRef.current.push(setTimeout(sendStart, 3000));
          useCaptions = true;
        }
      } catch (err) {
        debug('Failed to detect meeting platform:', err);
      }

      // Reset session-scoped diagnostics on every new recording.
      setDiagnostics((d) => ({ ...d, captionsReceived: 0, lastCaptionAt: 0 }));

      if (useCaptions) {
        // CC mode: captions come from content script with real speaker names
        setRecordingSync(true, 'captions');
        return;
      }

      // Mic mode: set up mic and start speech recognition
      captureModeRef.current = 'mic';
      setCaptureMode('mic');
      const success = await setupMic(options?.deviceId, options?.volume);
      if (!success) return;

      setRecordingSync(true, 'mic');

      if (bilingual && primaryLang !== secondaryLang) {
        startBilingualRecognition(primaryLang, secondaryLang);
      } else {
        startSingleRecognition(primaryLang);
      }
    },
    [setupMic, bilingual, primaryLang, secondaryLang, startBilingualRecognition, startSingleRecognition],
  );

  const stopRecording = useCallback(() => {
    // Cancel any pending START retry timers so a delayed START can't arrive
    // after the user has already pressed Stop.
    for (const t of startRetryTimersRef.current) clearTimeout(t);
    startRetryTimersRef.current = [];
    stopAllRecognition();
    cleanupMic();
    chrome.runtime.sendMessage({ type: MsgType.STOP_CAPTION_SCRAPING }).catch(() => {});
    setRecordingSync(false);
    setInterimText('');

    // Auto-persist the session.  We read from refs so this callback
    // doesn't need segments/elapsed/etc. in its deps (which would
    // re-register the useEffect listeners on every caption update).
    const segs = segmentsRef.current;
    if (segs.length === 0) return;
    const names = speakerNamesRef.current;
    const rendered = segs.map((s) => `[${names[s.speaker] || s.speaker}] ${s.text}`).join('\n');
    persistTranscript({
      meetingTitle: meetingTitleRef.current || 'Untitled meeting',
      date: new Date().toISOString(),
      duration: elapsedRef.current,
      language: primaryLangRef.current,
      transcript: rendered,
      segments: segs,
      speakerNames: names,
    }).catch((err) => {
      const msg =
        err instanceof StorageQuotaError
          ? 'Transcript too large to save — download it manually before closing.'
          : 'Failed to save transcript to local storage.';
      setSaveError(msg);
    });
  }, [stopAllRecognition, cleanupMic, setRecordingSync]);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setInterimText('');
  }, []);

  // Restore a past session into the live UI.  Refuses while recording to
  // avoid clobbering an in-progress transcript.
  const loadTranscript = useCallback(
    (
      loadSegments: TranscriptSegment[],
      loadSpeakerNames: Record<string, string>,
      loadMeetingTitle: string,
      loadDuration: number,
    ) => {
      if (isRecordingRef.current) return false;
      setSegments(loadSegments);
      setSpeakerNames((prev) => ({ ...prev, ...loadSpeakerNames }));
      setMeetingTitle(loadMeetingTitle);
      setElapsed(loadDuration);
      setInterimText('');
      return true;
    },
    [],
  );

  const fullTranscript = segments
    .map((s) => {
      const name = speakerNames[s.speaker] || s.speaker;
      return `[${name}] ${s.text}`;
    })
    .join('\n');

  return {
    segments,
    interimText,
    fullTranscript,
    isRecording,
    elapsed,
    error,
    primaryLang,
    secondaryLang,
    bilingual,
    captureMode,
    meetingTitle,
    diagnostics,
    segmentLimitReached,
    saveError,
    changePrimaryLang,
    changeSecondaryLang,
    toggleBilingual,
    speakerNames,
    renameSpeaker,
    participants,
    startRecording,
    stopRecording,
    clearTranscript,
    loadTranscript,
  };
}
