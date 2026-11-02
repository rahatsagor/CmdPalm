import Observation
import ServiceManagement

/// Open at Login, backed by the system's login item list so the setting stays
/// in sync with System Settings → General → Login Items.
@MainActor
@Observable
final class LoginItem {
    /// Registered with the system, even if switched off in Login Items, so
    /// turning the setting off still unregisters it.
    private(set) var isEnabled = LoginItem.isRegistered(SMAppService.mainApp.status)
    private(set) var needsApproval = SMAppService.mainApp.status == .requiresApproval
    private(set) var error: String?

    func refresh() {
        let status = SMAppService.mainApp.status
        isEnabled = Self.isRegistered(status)
        needsApproval = status == .requiresApproval
    }

    private nonisolated static func isRegistered(_ status: SMAppService.Status) -> Bool {
        status == .enabled || status == .requiresApproval
    }

    func set(_ enabled: Bool) {
        error = nil
        if enabled, let problem = Self.locationProblem(Bundle.main.bundleURL) {
            error = problem
            return
        }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            self.error = error.localizedDescription
        }
        refresh()
    }

    func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    /// A copy opened from the disk image, or one macOS runs from a hidden
    /// folder because it was never moved out of Downloads, is gone after a
    /// restart, so the login item would open nothing.
    nonisolated static func locationProblem(_ app: URL) -> String? {
        let readOnly = (try? app.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) ?? false
        return locationProblem(path: app.path, onReadOnlyVolume: readOnly)
    }

    nonisolated static func locationProblem(path: String, onReadOnlyVolume: Bool) -> String? {
        guard onReadOnlyVolume || path.contains("/AppTranslocation/") else { return nil }
        return "Move CmdPalm to your Applications folder and open it from there, then turn this on."
    }
}
