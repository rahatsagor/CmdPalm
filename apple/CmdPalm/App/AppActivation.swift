import AppKit

/// CmdPalm lives in the menu bar. While one of its windows is open it shows
/// in the Dock and app switcher so the window can be found and focused.
@MainActor
final class AppActivation {
    static let shared = AppActivation()

    private var reasons: Set<String> = []

    private init() {}

    func enter(_ reason: String = "updater") {
        reasons.insert(reason)
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
        NSApp.activate()
    }

    func leave(_ reason: String = "updater") {
        guard reasons.remove(reason) != nil, reasons.isEmpty else { return }
        // Let the window finish closing before the Dock icon disappears, or
        // focus can jump to an unrelated app's window.
        DispatchQueue.main.async {
            if self.reasons.isEmpty { NSApp.setActivationPolicy(.accessory) }
        }
    }

    /// Runs a modal alert or panel in front of other apps.
    func present<T>(_ body: () -> T) -> T {
        enter("modal")
        defer { leave("modal") }
        return body()
    }
}
