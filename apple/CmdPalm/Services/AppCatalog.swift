import AppKit
import Synchronization

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
    private let ownID = Bundle.main.bundleIdentifier ?? ""

    /// Forget the scan so the next request picks up new or removed apps.
    func invalidate() {
        cache.withLock { $0.scannedAt = .distantPast }
    }

    /// Extra folders to scan besides the standard Applications folders.
    func setCustomFolders(_ paths: [String]) {
        let urls = paths.map { URL(fileURLWithPath: $0, isDirectory: true) }
        cache.withLock {
            $0.customFolders = urls
            $0.scannedAt = .distantPast
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
        for app in workspace.runningApplications where app.activationPolicy == .regular {
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
        DispatchQueue.main.async {
            Self.apply(op, running: NSRunningApplication.runningApplications(withBundleIdentifier: id).first, url: url)
        }
        return true
    }

    @MainActor
    private static func apply(_ op: AppOp, running: NSRunningApplication?, url: URL?) {
        switch op {
        case .open:
            open(running: running, url: url)
        case .toggle:
            if let running, running.isActive, !running.isHidden {
                running.hide()
            } else {
                open(running: running, url: url)
            }
        case .hide:
            running?.hide()
        case .quit:
            running?.terminate()
        }
    }

    @MainActor
    private static func open(running: NSRunningApplication?, url: URL?) {
        if let running, running.isHidden { running.unhide() }
        guard let url = url ?? running?.bundleURL else { return }
        // Opening (rather than activating) also works when CmdPalm itself is
        // in the background, and reopens a window if the app has none.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error { NSLog("CmdPalm: could not open %@: %@", url.path, error.localizedDescription) }
        }
    }

    private func location(of id: String) -> URL? {
        if let app = installed()[id] { return app.url }
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
    }

    private func installed() -> [String: Installed] {
        let (fresh, custom) = cache.withLock { cache in
            (Date().timeIntervalSince(cache.scannedAt) < Self.maxAge ? cache.apps : nil, cache.customFolders)
        }
        if let fresh { return fresh }
        let apps = Self.scan(custom: custom)
        cache.withLock { cache in
            // Keep the folders if they changed during the scan; the next
            // request rescans.
            if cache.customFolders == custom {
                cache.apps = apps
                cache.scannedAt = Date()
            }
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
