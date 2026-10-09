import Foundation
import Synchronization

/// A late-bound, weak reference to the core host, for services created
/// before it and called from other threads.
final class HostReference: @unchecked Sendable {
    private let lock = NSLock()
    private weak var value: CoreHost?

    var host: CoreHost? {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// Answers the core's requests for things only macOS frameworks can do. The
/// core calls these from its network threads, never the main thread.
final class HostBridge: HostDelegate, Sendable {
    let apps: AppCatalog
    let volume: AudioVolume
    let pasteboard: Pasteboard
    let speech: SpeechService
    /// Mirrors the host config's `allowShell`, which also governs file URLs.
    private let allowsShell = Mutex(false)
    private let events: @Sendable (HostEvent) -> Void

    init(apps: AppCatalog, volume: AudioVolume, pasteboard: Pasteboard, speech: SpeechService, events: @escaping @Sendable (HostEvent) -> Void) {
        self.apps = apps
        self.volume = volume
        self.pasteboard = pasteboard
        self.speech = speech
        self.events = events
    }

    func setAllowsShell(_ allowed: Bool) { allowsShell.withLock { $0 = allowed } }

    func onEvent(event: HostEvent) { events(event) }

    func listApps() -> [AppEntry] { apps.list() }

    func appIcon(id: String, size: UInt32) -> Data? { apps.icon(id: id, size: size) }

    func appAction(id: String, op: AppOp) -> Bool { apps.perform(id: id, op: op) }

    func openUrl(url: String) -> Bool { SystemActions.open(url, allowFiles: allowsShell.withLock { $0 }) }

    func native(command: NativeCommand) -> Bool { SystemActions.run(command) }

    func runShortcut(name: String) -> Bool { SystemActions.runShortcut(name) }

    func setVolume(value: Float?, muted: Bool?) { volume.set(value: value, muted: muted) }

    func clipboardText() -> String? { pasteboard.text() }

    func setClipboardText(text: String) { pasteboard.setText(text) }

    func beginPaste(text: String) -> Bool { pasteboard.beginPaste(text) }

    func endPaste() { pasteboard.endPaste() }

    func voiceStart(session: UInt64, locale: String?) -> Bool { speech.start(session: session, locale: locale) }

    func voiceAudio(session: UInt64, pcm: Data) { speech.append(session: session, pcm: pcm) }

    func voiceStop(session: UInt64, cancel: Bool) { speech.stop(session: session, cancel: cancel) }
}
