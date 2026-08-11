import React, { useState, useRef, useEffect } from 'react';
import ChatContainer, { type ChatMessage } from './ChatContainer';

// Minimal shape of the Web Speech API surface this component uses. The DOM lib
// ships no `SpeechRecognition` types (it is still vendor-prefixed), which is why
// every handler here was typed `any`; declaring just the members we touch keeps
// the callbacks checked without pulling in a dependency.
interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike { readonly error: string }
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface ChatWithVoiceProps {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  hasTranscript: boolean;
  quotaWarning?: string | null;
  onSend: (message: string) => void;
  onClear: () => void;
  onAddSession?: () => void;
  onDeleteSession?: () => void;
  canDelete?: boolean;
  title?: string;
  showControls?: boolean;
  // Mobile control
  onMobileCommand?: (command: string) => void;
  isMobileConnected?: boolean;
}

export default function ChatWithVoice({
  messages,
  isLoading,
  error,
  hasTranscript,
  quotaWarning,
  onSend,
  onClear,
  onAddSession,
  onDeleteSession,
  canDelete = true,
  title,
  showControls = true,
  onMobileCommand,
  isMobileConnected = false
}: ChatWithVoiceProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [input, setInput] = useState('');
  // NOTE: transcription runs through the Web Speech API (`recognitionRef`), not
  // MediaRecorder. The `mediaRecorderRef`/`audioChunksRef` that used to sit here
  // were never assigned or read — leftovers of a raw-audio path this component
  // no longer takes.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Initialize Web Speech API
  useEffect(() => {
    const w = window as unknown as {
      webkitSpeechRecognition?: SpeechRecognitionCtor;
      SpeechRecognition?: SpeechRecognitionCtor;
    };
    const SpeechRecognition = w.webkitSpeechRecognition || w.SpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setIsRecording(true);
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;

          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        if (finalTranscript) {
          setInput((prev) => prev + ' ' + finalTranscript);
          if (onMobileCommand) {
            onMobileCommand(`voice:${finalTranscript}`);
          }
        }

        // Show interim results in real-time
        if (interimTranscript) {
          setInput((prev) => prev.split('[interim]')[0] + ' [interim]' + interimTranscript);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
      };

      recognition.onend = () => {
        setIsRecording(false);
      };
    }
  }, [onMobileCommand]);

  const toggleVoiceInput = () => {
    if (isRecording && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else if (recognitionRef.current) {
      // Clear interim text
      setInput((prev) => prev.replace(/\s\[interim\].*/g, ''));
      recognitionRef.current.start();
    }
  };

  const handleSend = (msg: string) => {
    const cleanedMsg = msg.replace(/\s\[interim\].*/g, '').trim();
    if (cleanedMsg) {
      onSend(cleanedMsg);
      setInput('');
      if (onMobileCommand) {
        onMobileCommand(`send:${cleanedMsg}`);
      }
    }
  };

  // Handle keyboard shortcuts for mobile control
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ctrl/Cmd + M: Toggle voice
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        toggleVoiceInput();
      }
      // Ctrl/Cmd + Shift + A: Send to mobile
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'a') {
        e.preventDefault();
        if (onMobileCommand) {
          onMobileCommand(`quick-action:activate`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [onMobileCommand]);

  return (
    <div className="chat-with-voice">
      {/* Voice & Mobile Controls */}
      <div className="chat-voice-controls">
        {/* Voice Input Button */}
        <button
          className={`voice-input-btn ${isRecording ? 'recording' : ''}`}
          onClick={toggleVoiceInput}
          title="Toggle voice input (Ctrl+M)"
          aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
        >
          {isRecording ? (
            <>
              <span className="recording-dot"></span>
              Recording...
            </>
          ) : (
            '🎤'
          )}
        </button>

        {/* Mobile Status */}
        {isMobileConnected && (
          <div className="mobile-status connected">
            📱 Mobile Connected
          </div>
        )}
        {!isMobileConnected && (
          <div className="mobile-status disconnected">
            📱 Mobile Offline
          </div>
        )}
      </div>

      {/* Main Chat Container */}
      <ChatContainer
        messages={messages}
        isLoading={isLoading}
        error={error}
        hasTranscript={hasTranscript}
        quotaWarning={quotaWarning}
        onSend={handleSend}
        onClear={onClear}
        onAddSession={onAddSession}
        onDeleteSession={onDeleteSession}
        canDelete={canDelete}
        title={title}
        showControls={showControls}
      />

      {/* Input Enhancement Indicator */}
      {isRecording && (
        <div className="recording-indicator">
          🎙️ Listening... (Ctrl+M to stop)
        </div>
      )}

      {/* Real-time Input Display */}
      {input.includes('[interim]') && (
        <div className="interim-text">
          {input.replace(/\[interim\]/g, '').trim()}
          <span className="cursor">|</span>
        </div>
      )}
    </div>
  );
}
