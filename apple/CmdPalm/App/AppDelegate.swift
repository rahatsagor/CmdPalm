import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var model: AppModel { .shared }
    #if DEBUG
    private var debugWindow: NSWindow?
    #endif

    func applicationWillFinishLaunching(_ notification: Notification) {
        SystemInfo.redirectLogs()
        let level = AppModel.shared.preferences.logLevel.rawValue
        initLogging(filter: "warn,cmdpalm_core=\(level)")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Unit tests run inside the app; don't start serving or prompt.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
        if handOffToRunningCopy() { return }

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
        model.host.shutdown()
    }

    /// Two copies would fight over the port and both post input.
    private func handOffToRunningCopy() -> Bool {
        guard let id = Bundle.main.bundleIdentifier else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        guard let other = NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .first(where: { $0.processIdentifier != me })
        else { return false }
        other.activate()
        DispatchQueue.main.async { NSApp.terminate(nil) }
        return true
    }
}
