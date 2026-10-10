@preconcurrency import AVFoundation
@preconcurrency import Speech

/// Transcribes microphone audio streamed from the phone.
///
/// Each phone session gets a recognizer. Speech is split into phrases at
/// pauses: the current request is finished and a new one starts right away,
/// so finished phrases are typed while the person keeps talking.
final class SpeechService: @unchecked Sendable {
    // All mutable state below is confined to `queue`; recognition handlers
    // run there too because the recognizers' operation queue targets it.
    private let queue = DispatchQueue(label: "app.cmdpalm.speech", qos: .userInitiated)
    private let handlerQueue: OperationQueue
    private var sessions: [UInt64: Session] = [:]
    private let update: @Sendable (UInt64, VoiceUpdate) -> Void

    private static let pause: TimeInterval = 1.2
    private static let stopTimeout: TimeInterval = 2.5
    private static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

    private final class Utterance {
        let generation: Int
        let request: SFSpeechAudioBufferRecognitionRequest
        var task: SFSpeechRecognitionTask?
        var text = ""

        init(generation: Int, request: SFSpeechAudioBufferRecognitionRequest) {
            self.generation = generation
            self.request = request
        }
    }

    private final class Session {
        let recognizer: SFSpeechRecognizer
        var current: Utterance?
        /// Utterances whose audio has ended but whose final text has not arrived.
        var closing: [Int: Utterance] = [:]
        var generation = 0
        var stopping = false
        var pauseTimer: DispatchWorkItem?
        /// Phrases in a row that ended without any text; guards against a
        /// recognizer that fails immediately every time it restarts.
        var emptyRestarts = 0

        init(recognizer: SFSpeechRecognizer) {
            self.recognizer = recognizer
        }
    }

    init(update: @escaping @Sendable (UInt64, VoiceUpdate) -> Void) {
        self.update = update
        handlerQueue = OperationQueue()
        handlerQueue.maxConcurrentOperationCount = 1
        handlerQueue.underlyingQueue = queue
    }

    static var authorization: SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    /// Speech can be used now or after the person allows it.
    static var mayBeAvailable: Bool {
        switch authorization {
        case .authorized, .notDetermined: true
        default: false
        }
    }

    func start(session id: UInt64, locale: String?) -> Bool {
        guard Self.mayBeAvailable, let recognizer = Self.recognizer(for: locale) else { return false }
        recognizer.queue = handlerQueue
        queue.async { [self] in
            if let old = sessions.removeValue(forKey: id) { discard(old) }
            sessions[id] = Session(recognizer: recognizer)
            switch Self.authorization {
            case .authorized:
                begin(id)
            case .notDetermined:
                SFSpeechRecognizer.requestAuthorization { [self] status in
                    queue.async { [self] in
                        if status == .authorized {
                            begin(id)
                        } else if let session = sessions.removeValue(forKey: id) {
                            discard(session)
                            send(id, .unavailable, message: "Speech recognition isn’t allowed on the Mac. Turn it on in System Settings → Privacy & Security → Speech Recognition.")
                        }
                    }
                }
            default:
                sessions[id] = nil
                send(id, .unavailable, message: "Speech recognition isn’t allowed on the Mac.")
            }
        }
        return true
    }

    /// 16 kHz mono signed 16-bit little-endian samples.
    func append(session id: UInt64, pcm: Data) {
        queue.async { [self] in
            guard let utterance = sessions[id]?.current, let buffer = Self.buffer(from: pcm) else { return }
            utterance.request.append(buffer)
        }
    }

    func stop(session id: UInt64, cancel: Bool) {
        queue.async { [self] in
            guard let session = sessions[id] else { return }
            if cancel {
                sessions[id] = nil
                discard(session)
                return
            }
            session.stopping = true
            session.pauseTimer?.cancel()
            if let current = session.current {
                current.request.endAudio()
            } else {
                finish(id, session)
            }
            queue.asyncAfter(deadline: .now() + Self.stopTimeout) { [self] in
                // The recognizer never delivered a final result.
                guard let session = sessions[id], session.stopping else { return }
                finish(id, session)
            }
        }
    }

    // MARK: Recognition

    private func begin(_ id: UInt64) {
        guard let session = sessions[id], !session.stopping else { return }
        // Speech never leaves the Mac: without on-device support for the
        // language, the recognizer would send audio to Apple's servers.
        guard session.recognizer.supportsOnDeviceRecognition else {
            sessions[id] = nil
            discard(session)
            send(id, .unavailable, message: "Speech is only transcribed on this Mac, and on-device recognition isn’t available for this language. Try another language, or turn on Dictation in System Settings → Keyboard so macOS can download it.")
            return
        }
        guard session.recognizer.isAvailable else {
            sessions[id] = nil
            discard(session)
            send(id, .unavailable, message: "Speech recognition isn’t available on the Mac right now. Try again in a moment.")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = true
        session.generation += 1
        let utterance = Utterance(generation: session.generation, request: request)
        let generation = utterance.generation
        utterance.task = session.recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(id, generation, result, error)
        }
        session.current = utterance
    }

    private func handle(_ id: UInt64, _ generation: Int, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let session = sessions[id] else { return }
        let isCurrent = session.current?.generation == generation
        guard let utterance = isCurrent ? session.current : session.closing[generation] else { return }

        if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal {
                completed(id, session, utterance, text: text)
            } else if isCurrent, text != utterance.text {
                utterance.text = text
                send(id, .listening, text: text)
                schedulePause(id, session, generation)
            }
            return
        }
        guard let error else { return }
        let code = (error as NSError).code
        // 1110: no speech detected; 301: request was cancelled; 1101/1107:
        // transient on-device service errors. All just end this phrase.
        if session.stopping || [1110, 301, 1101, 1107].contains(code) || utterance.text.isEmpty == false {
            completed(id, session, utterance, text: utterance.text)
        } else {
            sessions[id] = nil
            discard(session)
            send(id, .error, message: "Speech recognition stopped: \(error.localizedDescription)")
        }
    }

    /// An utterance produced its final text.
    private func completed(_ id: UInt64, _ session: Session, _ utterance: Utterance, text: String) {
        let wasCurrent = session.current === utterance
        session.closing[utterance.generation] = nil
        utterance.task = nil
        if wasCurrent { session.current = nil }
        let text = text.trimmingCharacters(in: .whitespaces)

        if session.stopping {
            if !text.isEmpty { send(id, .listening, text: text, final: true) }
            if session.current == nil, session.closing.isEmpty { finish(id, session) }
            return
        }
        if !text.isEmpty {
            session.emptyRestarts = 0
            send(id, .listening, text: text, final: true)
        } else if wasCurrent {
            session.emptyRestarts += 1
        }
        guard wasCurrent else { return }
        if session.emptyRestarts > 8 {
            sessions[id] = nil
            discard(session)
            send(id, .stopped)
        } else {
            begin(id)
        }
    }

    /// End the phrase after a pause and keep listening with a fresh request.
    private func schedulePause(_ id: UInt64, _ session: Session, _ generation: Int) {
        session.pauseTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let session = sessions[id], !session.stopping,
                  let current = session.current, current.generation == generation
            else { return }
            session.closing[generation] = current
            session.current = nil
            current.request.endAudio()
            begin(id)
        }
        session.pauseTimer = work
        queue.asyncAfter(deadline: .now() + Self.pause, execute: work)
    }

    private func finish(_ id: UInt64, _ session: Session) {
        guard sessions[id] === session else { return }
        sessions[id] = nil
        discard(session)
        send(id, .stopped)
    }

    private func discard(_ session: Session) {
        session.pauseTimer?.cancel()
        session.current?.task?.cancel()
        session.closing.values.forEach { $0.task?.cancel() }
        session.current = nil
        session.closing = [:]
    }

    private func send(_ id: UInt64, _ state: VoiceState, text: String? = nil, final: Bool = false, message: String? = nil) {
        update(id, VoiceUpdate(state: state, text: text, isFinal: final, message: message))
    }

    // MARK: Helpers

    private static func recognizer(for identifier: String?) -> SFSpeechRecognizer? {
        if let identifier, !identifier.isEmpty {
            let locale = Locale(identifier: identifier.replacingOccurrences(of: "_", with: "-"))
            if let recognizer = SFSpeechRecognizer(locale: locale) { return recognizer }
            if let language = locale.language.languageCode?.identifier,
               let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) {
                return recognizer
            }
        }
        return SFSpeechRecognizer()
    }

    private static func buffer(from pcm: Data) -> AVAudioPCMBuffer? {
        let frames = pcm.count / 2
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0]
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            for index in 0..<frames {
                let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                channel[index] = Float(sample) / 32_768
            }
        }
        return buffer
    }
}
