import AppKit
import Synchronization

/// Background callers wait for AppKit's result without blocking its main
/// queue. A timeout also invalidates work still waiting on the main queue.
final class AppActionCompletion: Sendable {
    private let result = Mutex<Bool?>(nil)
    private let done = DispatchSemaphore(value: 0)

    var isPending: Bool { result.withLock { $0 == nil } }

    func finish(_ success: Bool) {
        let changed = result.withLock { result in
            guard result == nil else { return false }
            result = success
            return true
        }
        if changed { done.signal() }
    }

    func wait(timeout: TimeInterval) -> Bool {
        if done.wait(timeout: .now() + timeout) == .timedOut { finish(false) }
        return result.withLock { $0 ?? false }
    }
}

/// Installed and running apps, for the phone's app launcher. Called from the
/// core's network threads.
final class AppCatalog: Sendable {
    private struct Installed: Sendable {
        let id: String
        let name: String
        let url: URL
    }

    private struct Cache {
        var apps: [String: Installed] = [:]
        var scannedAt = Date.distantPast
        var customFolders: [URL] = []
        /// Bumped when apps or folders may have changed, so a scan that was
        /// already running then doesn't count as fresh.
        var generation = 0
        var scans = 0
    }

    /// How deep to look inside a folder the person added, and how many items
    /// to look at in total, so adding a whole drive stays quick.
    static let customDepth = 3
    static let customItemLimit = 20_000

    private static let folders: [URL] = {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        return [
            "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
        ].map { URL(fileURLWithPath: $0, isDirectory: true) } + [home.appending(path: "Applications", directoryHint: .isDirectory)]
    }()

    private static let extras = ["/System/Library/CoreServices/Finder.app"].map { URL(fileURLWithPath: $0) }
    private static let maxAge: TimeInterval = 30

    private let cache = Mutex(Cache())
    /// One scan at a time. The app list and many icons are asked for at once
    /// after every app launch; they wait for one scan instead of each running
    /// their own on a core thread.
    private let scanning = NSLock()
    private let ownID = Bundle.main.bundleIdentifier ?? ""

    /// Forget the scan so the next request picks up new or removed apps.
    func invalidate() {
        cache.withLock {
            $0.scannedAt = .distantPast
            $0.generation += 1
        }
    }

    /// Extra folders to scan besides the standard Applications folders.
    func setCustomFolders(_ paths: [String]) {
        let urls = paths.map { URL(fileURLWithPath: $0, isDirectory: true) }
        cache.withLock {
            $0.customFolders = urls
            $0.scannedAt = .distantPast
            $0.generation += 1
        }
    }

    /// The apps found in one folder the way the catalog scans it, or nil when
    /// the folder is missing (for example on a drive that is not connected).
    static func apps(in folder: URL) -> [String]? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
        var found: [String: Installed] = [:]
        scanCustom(folder, into: &found)
        return found.values.map(\.name).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    func list() -> [AppEntry] {
        var entries: [String: AppEntry] = [:]
        for app in installed().values where app.id != ownID {
            entries[app.id] = AppEntry(id: app.id, name: app.name, running: false, active: false, hidden: false)
        }
        let workspace = NSWorkspace.shared
        let front = workspace.frontmostApplication?.bundleIdentifier
        // An app that is quitting can still be listed for a moment.
        for app in workspace.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
            guard let id = app.bundleIdentifier, id != ownID else { continue }
            let name = entries[id]?.name ?? app.localizedName ?? id
            entries[id] = AppEntry(id: id, name: name, running: true, active: id == front, hidden: app.isHidden)
        }
        return entries.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// PNG data for the app's icon, `size` pixels square.
    func icon(id: String, size: UInt32) -> Data? {
        guard let url = location(of: id) else { return nil }
        let pixels = Int(min(max(size, 16), 512))
        let image = NSWorkspace.shared.icon(forFile: url.path)
        return Self.png(image, pixels: pixels)
    }

    func perform(id: String, op: AppOp) -> Bool {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: id).first
        let url = running?.bundleURL ?? location(of: id)
        guard running != nil || url != nil else { return false }
        if running == nil, op == .hide || op == .quit { return true }
        // The core calls from a background worker. Waiting on the main
        // thread would prevent AppKit from ever completing the operation.
        guard !Thread.isMainThread else { return false }
        let completion = AppActionCompletion()
        DispatchQueue.main.async {
            guard completion.isPending else { return }
            Self.apply(op, running: NSRunningApplication.runningApplications(withBundleIdentifier: id).first, url: url, completion: completion)
        }
        return completion.wait(timeout: 10)
    }

    @MainActor
    private static func apply(_ op: AppOp, running: NSRunningApplication?, url: URL?, completion: AppActionCompletion) {
        switch op {
        case .open:
            open(running: running, url: url, completion: completion)
        case .toggle:
            if let running, running.isActive, !running.isHidden {
                completion.finish(running.hide())
            } else {
                open(running: running, url: url, completion: completion)
            }
        case .hide:
            completion.finish(running?.hide() ?? true)
        case .quit:
            completion.finish(running?.terminate() ?? true)
        }
    }

    @MainActor
    private static func open(running: NSRunningApplication?, url: URL?, completion: AppActionCompletion) {
        if let running, running.isHidden { running.unhide() }
        guard let url = url ?? running?.bundleURL else { completion.finish(false); return }
        // Opening (rather than activating) also works when CmdPalm itself is
        // in the background, and reopens a window if the app has none.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { opened, error in
            DispatchQueue.main.async {
                guard error == nil, let opened else { completion.finish(false); return }
                waitForActivation(of: opened, completion: completion)
            }
        }
    }

    @MainActor
    private static func waitForActivation(of app: NSRunningApplication, completion: AppActionCompletion) {
        guard completion.isPending else { return }
        if app.isTerminated { completion.finish(false) }
        else if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, !app.isHidden {
            completion.finish(true)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) {
                waitForActivation(of: app, completion: completion)
            }
        }
    }

    private func location(of id: String) -> URL? {
        if let app = installed()[id] { return app.url }
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
    }

    private func installed() -> [String: Installed] {
        let before = cache.withLock { cache in
            (fresh: Date().timeIntervalSince(cache.scannedAt) < Self.maxAge ? cache.apps : nil, scans: cache.scans)
        }
        if let fresh = before.fresh { return fresh }
        scanning.lock()
        defer { scanning.unlock() }
        let now = cache.withLock { cache in
            (
                fresh: Date().timeIntervalSince(cache.scannedAt) < Self.maxAge ? cache.apps : nil,
                latest: cache.apps, scans: cache.scans, custom: cache.customFolders, generation: cache.generation
            )
        }
        if let fresh = now.fresh { return fresh }
        // A scan finished while this request waited; it is recent enough even
        // if something changed during it.
        if now.scans != before.scans { return now.latest }
        let apps = Self.scan(custom: now.custom)
        cache.withLock { cache in
            cache.apps = apps
            cache.scans += 1
            // Apps or folders changed during the scan; the next request rescans.
            if cache.generation == now.generation { cache.scannedAt = Date() }
        }
        return apps
    }

    private static func add(_ url: URL, to found: inout [String: Installed]) {
        guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, found[id] == nil else { return }
        if bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool == true { return }
        let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "", options: [.anchored, .backwards])
        found[id] = Installed(id: id, name: name, url: url)
    }

    /// Apps anywhere inside `folder`, a few levels deep, without looking
    /// inside app bundles or following symbolic links.
    private static func scanCustom(_ folder: URL, into found: inout [String: Installed]) {
        if folder.pathExtension == "app" {
            add(folder, to: &found)
            return
        }
        guard let enumerator = FileManager.default.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return }
        var seen = 0
        for case let item as URL in enumerator {
            seen += 1
            if seen > customItemLimit { break }
            if item.pathExtension == "app" {
                add(item, to: &found)
            } else if enumerator.level >= customDepth {
                enumerator.skipDescendants()
            }
        }
    }

    private static func scan(custom: [URL]) -> [String: Installed] {
        let manager = FileManager.default
        var found: [String: Installed] = [:]
        func add(_ url: URL) { Self.add(url, to: &found) }
        for folder in folders {
            // Not .skipsHiddenFiles: macOS marks /Applications/Safari.app (a
            // link into its system cryptex) hidden, yet Finder lists it.
            guard let items = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey]) else { continue }
            for item in items where !item.lastPathComponent.hasPrefix(".") {
                if item.pathExtension == "app" {
                    add(item)
                } else if (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true, item.lastPathComponent != "Utilities" {
                    // Suites such as "Microsoft Office" keep their apps one level down.
                    let nested = (try? manager.contentsOfDirectory(at: item, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
                    nested.filter { $0.pathExtension == "app" }.forEach(add)
                }
            }
        }
        extras.forEach(add)
        // After the standard folders, so an app installed in both opens the
        // copy in Applications.
        for folder in custom {
            scanCustom(folder, into: &found)
        }
        return found
    }

    private static func png(_ image: NSImage, pixels: Int) -> Data? {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        rep.size = NSSize(width: pixels, height: pixels)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}
