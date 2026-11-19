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
    private(set) var canView = CGPreflightScreenCaptureAccess()

    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pollInterval: TimeInterval = 0
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    /// `CGPreflightPostEventAccess` keeps returning its first answer until the
    /// app relaunches, so a grant made in System Settings would go unnoticed.
    /// The Accessibility trust check reflects changes immediately.
    nonisolated static func isTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    func startMonitoring() {
        guard observers.isEmpty else { return }
        scheduleTimer()
        // Coming back from System Settings should update at once; going to the
        // background lets us back off polling when permissions are already set.
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refresh()
                self?.scheduleTimer()
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleTimer() }
        })
    }

    private func scheduleTimer() {
        let needsFastPoll = !canControl || !canView || NSApp.isActive
        let interval: TimeInterval = needsFastPoll ? 1 : 15
        guard timer == nil || pollInterval != interval else { return }
        timer?.invalidate()
        pollInterval = interval
        // There is no notification for these; poll briskly while active or
        // waiting for a grant, and coalesce lazily when idle in the menu bar.
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer.tolerance = needsFastPoll ? 0.3 : 5
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func refresh() {
        let control = Self.isTrusted()
        let speech = SFSpeechRecognizer.authorizationStatus()
        let view = CGPreflightScreenCaptureAccess()
        guard control != canControl || speech != self.speech || view != canView else { return }
        canControl = control
        self.speech = speech
        canView = view
        if !observers.isEmpty { scheduleTimer() }
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

    /// Shows the system prompt the first time. macOS shows it only once, and
    /// it has its own button for System Settings, so the list is opened here
    /// only for later requests.
    func requestViewing() {
        guard !CGPreflightScreenCaptureAccess() else { refresh(); return }
        let defaults = UserDefaults.standard
        let asked = defaults.bool(forKey: Self.askedToViewKey)
        // Also adds CmdPalm to the Screen Recording list.
        _ = CGRequestScreenCaptureAccess()
        defaults.set(true, forKey: Self.askedToViewKey)
        if asked, !CGPreflightScreenCaptureAccess() { Self.openSettings("Privacy_ScreenCapture") }
        refresh()
    }

    private static let askedToViewKey = "screenRecordingRequested"

    static func openSettings(_ anchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        NSWorkspace.shared.open(url)
    }
}
