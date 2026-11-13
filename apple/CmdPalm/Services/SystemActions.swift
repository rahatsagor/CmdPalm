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

    /// File URLs can launch scripts, and these others open a terminal or
    /// connect to a file server, which can hand over the Mac's login. Matches
    /// `link_problem` in the core.
    static let shellLikeSchemes: Set<String> = ["file", "ssh", "telnet", "x-man-page", "smb", "cifs", "afp", "nfs", "ftp"]

    /// Opens a deck button's link. Links that act like shell commands are
    /// only allowed when shell commands are.
    static func open(_ string: String, allowShellLike: Bool = false) -> Bool {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(), !scheme.isEmpty else { return false }
        guard !["javascript", "data"].contains(scheme), allowShellLike || !shellLikeSchemes.contains(scheme) else { return false }
        DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        return true
    }

    static func runShortcut(_ name: String) -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return false }
        // "--" so a name starting with "-" isn't read as an option.
        return launch("/usr/bin/shortcuts", ["run", "--", name], timeout: 60)
    }

    private static func openApp(at path: String) -> Bool {
        guard FileManager.default.fileExists(atPath: path) else { return false }
        guard !Thread.isMainThread else { return false }
        let url = URL(fileURLWithPath: path)
        let completion = AppActionCompletion()
        DispatchQueue.main.async {
            guard completion.isPending else { return }
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { app, error in
                completion.finish(app != nil && error == nil)
            }
        }
        return completion.wait(timeout: 5)
    }

    /// Called on the action worker so sequence steps wait for the tool's result.
    static func launch(_ tool: String, _ arguments: [String], timeout: TimeInterval = 15) -> Bool {
        guard !Thread.isMainThread else { return false }
        let process = Process()
        let completion = AppActionCompletion()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { task in
            completion.finish(task.terminationReason == .exit && task.terminationStatus == 0)
        }
        do {
            try process.run()
            let success = completion.wait(timeout: timeout)
            if process.isRunning {
                process.terminate()
                // A timed-out Shortcut must not silently continue past later steps.
                let until = Date().addingTimeInterval(1)
                while process.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.01) }
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
            }
            return success
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
