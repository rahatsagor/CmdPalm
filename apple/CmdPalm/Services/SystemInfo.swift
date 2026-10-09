import AppKit
import SystemConfiguration

enum SystemInfo {
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    static var buildNumber: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }

    /// The Bonjour name other devices can use to reach this Mac, e.g.
    /// `Studio.local`. Empty if the Mac has none.
    static var bonjourHostName: String {
        guard let name = SCDynamicStoreCopyLocalHostName(nil) as String?, !name.isEmpty else { return "" }
        return "\(name).local"
    }

    /// The name set in System Settings → General → Sharing.
    static var computerName: String {
        if let name = SCDynamicStoreCopyComputerName(nil, nil) as String?, !name.isEmpty {
            return name
        }
        return Host.current().localizedName ?? "Mac"
    }

    static var dataDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Library/Application Support")
        return base.appending(path: "CmdPalm", directoryHint: .isDirectory)
    }

    static var logDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Library/Logs/CmdPalm", directoryHint: .isDirectory)
    }

    static var logFile: URL { logDirectory.appending(path: "CmdPalm.log") }

    static var webRoot: URL? {
        guard let url = Bundle.main.resourceURL?.appending(path: "web", directoryHint: .isDirectory),
              FileManager.default.fileExists(atPath: url.appending(path: "index.html").path)
        else { return nil }
        return url
    }

    /// Key repeat and double-click timing from System Settings, in ms.
    static var inputTiming: (repeatDelay: UInt32, repeatInterval: UInt32, doubleClick: UInt32) {
        func ms(_ seconds: TimeInterval) -> UInt32 { UInt32(max(0, min(seconds * 1000, 10_000)).rounded()) }
        return (ms(NSEvent.keyRepeatDelay), ms(NSEvent.keyRepeatInterval), ms(NSEvent.doubleClickInterval))
    }

    /// Sends the core's log output (written to stderr) to a file, keeping one
    /// previous file once it grows past 2 MB.
    static func redirectLogs() {
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        rotateLogIfNeeded()
        // Keep stderr when run from a terminal so logs stay visible there.
        guard isatty(STDERR_FILENO) == 0 else { return }
        freopen(logFile.path, "a", stderr)
        setvbuf(stderr, nil, _IOLBF, 0)

        let timer = Timer(timeInterval: 4 * 60 * 60, repeats: true) { _ in
            if rotateLogIfNeeded() { reopenLog() }
        }
        timer.tolerance = 10 * 60
        RunLoop.main.add(timer, forMode: .common)
    }

    @discardableResult
    private static func rotateLogIfNeeded() -> Bool {
        let manager = FileManager.default
        guard let size = try? manager.attributesOfItem(atPath: logFile.path)[.size] as? Int, size > 2_000_000 else {
            return false
        }
        let previous = logDirectory.appending(path: "CmdPalm.previous.log")
        try? manager.removeItem(at: previous)
        return (try? manager.moveItem(at: logFile, to: previous)) != nil
    }

    /// Points stderr at a fresh log file after rotation. The core writes to
    /// fd 2 from other threads, so this swaps it with dup2, which is atomic,
    /// rather than freopen, which closes fd 2 first and lets another thread's
    /// open() take that number in the gap.
    private static func reopenLog() {
        fflush(stderr)
        let fd = open(logFile.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        guard fd >= 0 else { return }
        dup2(fd, STDERR_FILENO)
        close(fd)
    }
}
