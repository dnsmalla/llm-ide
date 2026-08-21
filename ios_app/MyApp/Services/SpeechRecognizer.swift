import Foundation
import Speech
import AVFoundation

/// On-device speech-to-text for voice control. Publishes a live transcript
/// while listening; the caller takes the final transcript on finish().
///
/// Session lifecycle is guarded because both permission prompts are async: a
/// second `start()` arriving before the first finishes used to build a SECOND
/// AVAudioEngine and overwrite the first without tearing it down, leaving a
/// running engine holding the microphone (and an orphaned recognition task) for
/// the rest of the process. `finish()` also waits for the recognizer's FINAL
/// result instead of cancelling the task immediately, which previously threw
/// away everything past the last partial.
@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published var transcript: String = ""
    @Published var isListening: Bool = false
    @Published var errorMessage: String?

    private let recognizer = SFSpeechRecognizer()
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// True from the moment `start()` is called until the session is torn down.
    /// Set SYNCHRONOUSLY — `isListening` only flips after two async permission
    /// callbacks, so it cannot serve as the re-entrancy guard.
    private var isStarting = false
    /// Bumped by every `start()`/teardown. `beginSession` bails when its
    /// captured value is stale, so a Start immediately followed by Stop can no
    /// longer open the mic *after* the user asked it to stop (the permission
    /// callbacks are async and used to call `beginSession()` unconditionally).
    private var startGeneration = 0
    /// Backstop for `finish()`: it keeps the recognition task alive to collect
    /// the final result, so if that result never arrives the audio session
    /// would stay active in `.record` forever.
    private var finishWatchdog: Task<Void, Never>?
    /// Category to restore on teardown: leaving the app in `.record` affects
    /// any later playback.
    private var previousCategory: AVAudioSession.Category?

    func start() {
        guard !isStarting, !isListening else { return }
        isStarting = true
        startGeneration &+= 1
        let generation = startGeneration
        // A watchdog armed by the PREVIOUS finish() must not fire into this
        // session — it would tear down a live dictation mid-sentence.
        finishWatchdog?.cancel()
        finishWatchdog = nil
        transcript = ""
        errorMessage = nil
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard let self, generation == self.startGeneration else { return }
                guard status == .authorized else {
                    self.errorMessage = "Speech recognition not allowed. Enable it in Settings → LLM-IDE."
                    self.isStarting = false
                    return
                }
                self.requestMicrophone { granted in
                    Task { @MainActor in
                        guard generation == self.startGeneration else { return }
                        guard granted else {
                            self.errorMessage = "Microphone access needed. Enable it in Settings → LLM-IDE."
                            self.isStarting = false
                            return
                        }
                        self.beginSession(generation: generation)
                    }
                }
            }
        }
    }

    /// `AVAudioSession.requestRecordPermission` is deprecated from iOS 17.
    private func requestMicrophone(_ completion: @escaping @Sendable (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }

    /// Stop listening and keep the current transcript for the caller.
    ///
    /// Stops feeding audio and closes the request, but leaves the recognition
    /// task running so its `isFinal` result can land — the old code cancelled
    /// the task here, so the caller only ever got the last PARTIAL
    /// transcription. `stopCapture` makes the mic release immediate either way.
    func finish() {
        guard isListening || isStarting else { return }
        startGeneration &+= 1   // cancel any in-flight start
        stopCapture()
        request?.endAudio()
        request = nil
        isListening = false
        isStarting = false
        // `task` intentionally left alive; the recognitionTask callback clears
        // it once it reports a final result or an error. If neither ever
        // arrives, this watchdog restores the audio session anyway.
        guard task != nil else { return }
        let watchdogGeneration = startGeneration
        finishWatchdog?.cancel()
        finishWatchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled, let self,
                  // Only clean up the session this watchdog was armed for.
                  watchdogGeneration == self.startGeneration,
                  self.task != nil else { return }
            self.tearDown()
        }
    }

    /// Stop listening and discard the transcript.
    func cancel() {
        transcript = ""
        tearDown()
    }

    private func beginSession(generation: Int) {
        // Second guard: `start()`'s permission callbacks are async, so this can
        // still be reached twice, and a `finish()`/`cancel()` may have landed in
        // between. An engine already exists, or a newer/cancelled generation →
        // never build another.
        guard generation == startGeneration, isStarting, audioEngine == nil else {
            isStarting = false
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition is not available on this device."
            isStarting = false
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            previousCategory = session.category
            // No `.duckOthers`: it is a playback/mixing option and has no
            // meaning for a `.record` category.
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()

            audioEngine = engine
            self.request = request
            isListening = true
            isStarting = false

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    // A STALE task's final result must not tear down (and bump
                    // the generation of) whatever session is live now — that
                    // silently cancelled the next start().
                    guard generation == self.startGeneration else { return }
                    if let result {
                        self.transcript = result.bestTranscription.formattedString
                        if result.isFinal {
                            self.task = nil
                            self.tearDown()
                        }
                    }
                    if let error {
                        // Surfaced, not swallowed: listening used to die
                        // silently while the UI kept an error slot unused.
                        if self.isListening {
                            self.errorMessage = "Speech recognition stopped: \(error.localizedDescription)"
                        }
                        self.task = nil
                        self.tearDown()
                    }
                }
            }
        } catch {
            errorMessage = "Could not start the microphone: \(error.localizedDescription)"
            tearDown()
        }
    }

    /// Release the microphone (engine + tap) without touching the recognition
    /// task — shared by `finish()` (which still wants the final result) and
    /// `tearDown()`.
    private func stopCapture() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
    }

    private func tearDown() {
        startGeneration &+= 1
        finishWatchdog?.cancel()
        finishWatchdog = nil
        stopCapture()
        task?.cancel()
        task = nil
        request = nil
        isListening = false
        isStarting = false
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        // Restore whatever category the app had before recording.
        if let previousCategory {
            try? session.setCategory(previousCategory)
            self.previousCategory = nil
        }
    }
}
