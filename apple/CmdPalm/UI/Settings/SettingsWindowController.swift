import AppKit
import SwiftUI

/// The settings window. Created with AppKit so `.fullSizeContentView` is set
/// from the start, which macOS 26 needs for its glass sidebar and title bar.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private static var shared: SettingsWindowController?

    static func show(tab: SettingsTab? = nil) {
        if let tab { SettingsNavigation.shared.selection = tab }
        if shared == nil { shared = SettingsWindowController() }
        shared?.showWindow(nil)
    }

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 580),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)
        window.title = "CmdPalm Settings"
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("SettingsWindow")
        window.minSize = NSSize(width: 680, height: 480)
        window.center()
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: SettingsView().appEnvironment())
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func showWindow(_ sender: Any?) {
        AppActivation.shared.enter("settings")
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        AppActivation.shared.leave("settings")
        Self.shared = nil
    }
}

@MainActor
final class WelcomeWindowController: NSWindowController, NSWindowDelegate {
    private static var shared: WelcomeWindowController?

    static func show() {
        if shared == nil { shared = WelcomeWindowController() }
        shared?.showWindow(nil)
    }

    static func close() {
        shared?.close()
    }

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)
        window.title = "Welcome to CmdPalm"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.center()
        window.delegate = self
        let hosting = NSHostingController(rootView: WelcomeView().appEnvironment())
        hosting.sizingOptions = [.preferredContentSize]
        window.contentViewController = hosting
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func showWindow(_ sender: Any?) {
        AppActivation.shared.enter("welcome")
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        AppModel.shared.preferences.onboarded = true
        AppActivation.shared.leave("welcome")
        Self.shared = nil
    }
}
