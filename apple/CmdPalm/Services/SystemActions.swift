import AppKit

/// System actions deck buttons can trigger.
enum SystemActions {
    static func run(_ command: NativeCommand) -> Bool {
        switch command {
        case .missionControl:
            return openApp(at: "/System/Applications/Mission Control.app")
        case .launchpad:
            // macOS 26 replaced Launchpad with the Apps app.
            return openApp(at: "/System/Applications/Apps.app") || openApp(at: "/System/Applications/Launchpad.app")
        case .lockScreen:
            return lockScreen()
        case .sleepDisplay:
            return launch("/usr/bin/pmset", ["displaysleepnow"])
        case .sleep:
            return launch("/usr/bin/pmset", ["sleepnow"])
        }
    }

    /// Opens a deck button's link. File URLs can launch scripts, so they are
    /// only allowed when shell commands are.
    static func open(_ string: String, allowFiles: Bool = false) -> Bool {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(), !scheme.isEmpty else { return false }
        guard !["javascript", "data"].contains(scheme), allowFiles || scheme != "file" else { return false }
        DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        return true
    }

    static func runShortcut(_ name: String) -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return false }
        return launch("/usr/bin/shortcuts", ["run", name])
    }

    private static func openApp(at path: String) -> Bool {
        guard FileManager.default.fileExists(atPath: path) else { return false }
        let url = URL(fileURLWithPath: path)
        DispatchQueue.main.async {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
        return true
    }

    private static func launch(_ tool: String, _ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return true
        } catch {
            NSLog("CmdPalm: could not run %@: %@", tool, error.localizedDescription)
            return false
        }
    }

    /// Locks the screen the same way as the menu bar's Lock Screen item.
    private static func lockScreen() -> Bool {
        typealias LockFunction = @convention(c) () -> Int32
        let path = "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"
        guard let handle = dlopen(path, RTLD_LAZY), let symbol = dlsym(handle, "SACLockScreenImmediate") else {
            return false
        }
        let lock = unsafeBitCast(symbol, to: LockFunction.self)
        _ = lock()
        return true
    }
}
