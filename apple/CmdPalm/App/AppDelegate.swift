import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var model: AppModel { .shared }
    #if DEBUG
    private var debugWindow: NSWindow?
    #endif

    /// Runs before anything creates the core, so messages it logs while
    /// loading its files, such as a damaged settings file, are kept.
    static func startLogging() {
        // Unit tests run inside the app; don't log, serve or prompt.
        guard !SystemInfo.isRunningTests else { return }
        SystemInfo.redirectLogs()
        initLogging(filter: "warn,cmdpalm_core=\(Preferences.storedLogLevel().rawValue)")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !SystemInfo.isRunningTests else { return }

        let model = model
        model.permissions.startMonitoring()
        model.host.onApprovalsChanged = { ApprovalPanel.update() }
        model.host.start()
        model.updater.start()

        #if DEBUG
        if showDebugWindows() { return }
        #endif
        if !model.preferences.onboarded {
            WelcomeWindowController.show()
        }
    }

    #if DEBUG
    /// Launch arguments for checking the UI during development:
    /// `-debugSettingsTab phone`, `-debugMenuPanel YES`, `-debugWelcome YES`.
    private func showDebugWindows() -> Bool {
        let defaults = UserDefaults.standard
        if let tab = defaults.string(forKey: "debugSettingsTab").flatMap(SettingsTab.init(rawValue:)) {
            SettingsWindowController.show(tab: tab)
            return true
        }
        if defaults.bool(forKey: "debugWelcome") {
            WelcomeWindowController.show()
            return true
        }
        if defaults.bool(forKey: "debugMenuPanel") {
            let window = NSWindow(contentViewController: NSHostingController(rootView: MenuPanel().appEnvironment()))
            window.title = "Menu Panel"
            window.styleMask.remove(.resizable)
            window.isReleasedWhenClosed = false
            window.center()
            window.makeKeyAndOrderFront(nil)
            debugWindow = window
            return true
        }
        return false
    }
    #endif

    /// Opening the app again (Finder, Spotlight, Homebrew) shows Settings, as
    /// the menu bar icon can be hidden behind the notch or by a menu bar manager.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { SettingsWindowController.show() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard !SystemInfo.isRunningTests else { return }
        model.host.shutdown()
    }

    /// Two copies would fight over the port and both post input, so a second
    /// copy reopens the running one, which shows Settings, and exits before
    /// creating anything.
    static func handOffToRunningCopy() {
        guard !SystemInfo.isRunningTests, let id = Bundle.main.bundleIdentifier else { return }
        let me = ProcessInfo.processInfo.processIdentifier
        guard let other = NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .first(where: { $0.processIdentifier != me })
        else { return }
        if let url = other.bundleURL {
            let done = DispatchSemaphore(value: 0)
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
                done.signal()
            }
            _ = done.wait(timeout: .now() + 5)
        } else {
            other.activate()
        }
        exit(0)
    }
}
