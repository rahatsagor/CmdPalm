import AppKit
import Observation
import Sparkle

/// Sparkle auto-updates. Releases are verified with the EdDSA key in
/// Info.plist, so updates work without an Apple Developer ID.
@MainActor
@Observable
final class Updater: NSObject {
    private(set) var canCheck = false
    /// Set when a scheduled check found an update the person hasn't seen.
    private(set) var pendingVersion: String?
    private(set) var lastChecked: Date?

    @ObservationIgnored private var controller: SPUStandardUpdaterController!
    @ObservationIgnored private var observation: NSKeyValueObservation?

    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
    }

    /// Debug builds and builds without a feed and signing key never update,
    /// so a development copy cannot replace itself with a release.
    var isConfigured: Bool {
        #if DEBUG
        return false
        #else
        guard let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              let url = URL(string: feed), url.scheme == "https", url.host != nil,
              let decoded = Data(base64Encoded: key), decoded.count == 32
        else { return false }
        return true
        #endif
    }

    var automaticallyChecks: Bool {
        get {
            access(keyPath: \.automaticallyChecks)
            return controller.updater.automaticallyChecksForUpdates
        }
        set {
            withMutation(keyPath: \.automaticallyChecks) {
                controller.updater.automaticallyChecksForUpdates = newValue
            }
        }
    }

    var automaticallyDownloads: Bool {
        get {
            access(keyPath: \.automaticallyDownloads)
            return controller.updater.automaticallyDownloadsUpdates
        }
        set {
            withMutation(keyPath: \.automaticallyDownloads) {
                controller.updater.automaticallyDownloadsUpdates = newValue
            }
        }
    }

    func start() {
        guard isConfigured else { return }
        controller.startUpdater()
        lastChecked = controller.updater.lastUpdateCheckDate
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.canCheck = self.controller.updater.canCheckForUpdates
            }
        }
    }

    func checkForUpdates() {
        guard isConfigured else {
            let alert = NSAlert()
            alert.messageText = "Updates aren’t available in this build"
            alert.informativeText = "This copy of CmdPalm was built locally without an update feed. Install a release from GitHub or Homebrew to get automatic updates."
            _ = AppActivation.shared.present { alert.runModal() }
            return
        }
        pendingVersion = nil
        AppActivation.shared.enter()
        controller.checkForUpdates(nil)
    }
}

extension Updater: SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: (any Error)?) {
        lastChecked = updater.lastUpdateCheckDate
    }
}

extension Updater: SPUStandardUserDriverDelegate {
    // Menu bar apps should not pop windows over whatever the person is doing;
    // scheduled finds are shown as a badge in the menu instead.
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        immediateFocus
    }

    nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        let version = update.displayVersionString
        let userInitiated = state.userInitiated
        Task { @MainActor in
            if !handleShowingUpdate, !userInitiated { self.pendingVersion = version }
            if handleShowingUpdate { AppActivation.shared.enter() }
        }
    }

    nonisolated func standardUserDriverWillFinishUpdateSession() {
        Task { @MainActor in AppActivation.shared.leave() }
    }
}
