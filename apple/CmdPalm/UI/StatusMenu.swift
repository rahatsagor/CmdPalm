import AppKit

/// A quick menu for right-clicking (or Control-clicking) the menu bar icon.
/// The SwiftUI menu bar item exposes no status item, so the click is found by
/// hit-testing the status bar button it lands on.
@MainActor
enum StatusMenu {
    private final class ActionItem: NSMenuItem {
        private let handler: () -> Void

        init(_ title: String, key: String = "", enabled: Bool = true, handler: @escaping () -> Void) {
            self.handler = handler
            super.init(title: title, action: #selector(run), keyEquivalent: key)
            target = self
            isEnabled = enabled
        }

        required init(coder: NSCoder) { fatalError() }

        @objc private func run() { handler() }
    }

    private static var monitor: Any?

    static func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { event in
            guard event.type == .rightMouseDown || event.modifierFlags.contains(.control),
                  let button = statusButton(for: event)
            else { return event }
            show(from: button, event: event)
            return nil
        }
    }

    /// `paused` is nil when the server isn't running.
    static func makeMenu(status: String, paused: Bool?, updatesEnabled: Bool, pause: @escaping () -> Void,
                         settings: @escaping () -> Void, updates: @escaping () -> Void, quit: @escaping () -> Void) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let header = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if let paused {
            menu.addItem(ActionItem(paused ? "Resume Control and Viewing" : "Pause Control and Viewing", handler: pause))
        }
        menu.addItem(.separator())
        menu.addItem(ActionItem("Settings…", key: ",", handler: settings))
        menu.addItem(ActionItem("Check for Updates…", enabled: updatesEnabled, handler: updates))
        menu.addItem(.separator())
        menu.addItem(ActionItem("Quit CmdPalm", key: "q", handler: quit))
        return menu
    }

    private static func statusButton(for event: NSEvent) -> NSStatusBarButton? {
        guard let content = event.window?.contentView else { return nil }
        let point = content.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        var view = content.hitTest(point)
        while let current = view {
            if let button = current as? NSStatusBarButton { return button }
            view = current.superview
        }
        return nil
    }

    private static func show(from button: NSStatusBarButton, event: NSEvent) {
        let model = AppModel.shared
        let host = model.host
        let updater = model.updater
        let menu = makeMenu(
            status: host.statusSummary,
            paused: host.isRunning ? host.paused : nil,
            updatesEnabled: !updater.isConfigured || updater.canCheck,
            pause: { host.setPaused(!host.paused) },
            settings: { SettingsWindowController.show() },
            updates: { updater.checkForUpdates() },
            quit: { NSApp.terminate(nil) }
        )
        button.highlight(true)
        NSMenu.popUpContextMenu(menu, with: event, for: button)
        button.highlight(false)
    }
}
