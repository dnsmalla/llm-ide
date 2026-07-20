import React, { useState, useRef, useEffect } from 'react';
import ChatContainer, { type ChatMessage } from './ChatContainer';

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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);

  // Initialize Web Speech API
  useEffect(() => {
    const SpeechRecognition = window.webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;

      recognitionRef.current.onstart = () => {
        setIsRecording(true);
      };

      recognitionRef.current.onresult = (event: any) => {
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

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
      };

      recognitionRef.current.onend = () => {
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

  const handleInputChange = (value: string) => {
    setInput(value);
    // Real-time feedback to mobile
    if (onMobileCommand && value) {
      onMobileCommand(`typing:${value}`);
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
