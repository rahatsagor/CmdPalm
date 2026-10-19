import AppKit
import ApplicationServices
import Observation
import Speech

/// Tracks the privacy permissions CmdPalm depends on.
@MainActor
@Observable
final class Permissions {
    /// Accessibility, which lets CmdPalm post keyboard and mouse events.
    private(set) var canControl = Permissions.isTrusted()
    private(set) var speech = SFSpeechRecognizer.authorizationStatus()

    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var activation: NSObjectProtocol?

    /// `CGPreflightPostEventAccess` keeps returning its first answer until the
    /// app relaunches, so a grant made in System Settings would go unnoticed.
    /// The Accessibility trust check reflects changes immediately.
    nonisolated static func isTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    func startMonitoring() {
        guard timer == nil else { return }
        // There is no notification for these; polling is cheap.
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer.tolerance = 0.3
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        // Coming back from System Settings should update at once.
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func refresh() {
        let control = Self.isTrusted()
        let speech = SFSpeechRecognizer.authorizationStatus()
        guard control != canControl || speech != self.speech else { return }
        canControl = control
        self.speech = speech
        onChange?()
    }

    /// Shows the system prompt (first time) and opens the Accessibility list.
    func requestControl() {
        // Adds CmdPalm to the Accessibility list so there is a switch to turn
        // on. Its answer can be stale, like CGPreflightPostEventAccess.
        _ = CGRequestPostEventAccess()
        if !Self.isTrusted() {
            Self.openSettings("Privacy_Accessibility")
        }
        refresh()
    }

    func requestSpeech() {
        switch speech {
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        case .denied, .restricted:
            Self.openSettings("Privacy_SpeechRecognition")
        default:
            break
        }
    }

    static func openSettings(_ anchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        NSWorkspace.shared.open(url)
    }
}
