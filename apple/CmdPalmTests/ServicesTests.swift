import AppKit
import Testing
@testable import CmdPalm

@Suite struct AppCatalogTests {
    let catalog = AppCatalog()

    @Test func listsSystemAppsSortedByName() {
        let apps = catalog.list()
        #expect(apps.contains { $0.id == "com.apple.finder" })
        #expect(apps.contains { $0.id == "com.apple.Safari" })
        #expect(!apps.contains { $0.id == Bundle.main.bundleIdentifier })
        let names = apps.map(\.name)
        #expect(names == names.sorted { $0.localizedStandardCompare($1) == .orderedAscending })
        #expect(apps.allSatisfy { !$0.name.hasSuffix(".app") })
    }

    @Test func finderIsAlwaysRunning() {
        let finder = catalog.list().first { $0.id == "com.apple.finder" }
        #expect(finder?.running == true)
    }

    @Test(arguments: [16, 64, 128, 700])
    func rendersSquarePNGIcons(size: Int) throws {
        let data = try #require(catalog.icon(id: "com.apple.Safari", size: UInt32(size)))
        let image = try #require(NSBitmapImageRep(data: data))
        let expected = min(max(size, 16), 512)
        #expect(image.pixelsWide == expected)
        #expect(image.pixelsHigh == expected)
    }

    @Test func scansCustomFoldersAndSkipsMissingOnes() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "cmdpalm-apps-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        // Two levels down, like "Drive/Apps/Games/Tool.app".
        let app = root.appending(path: "Games/Tools/Tool.app/Contents")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        let info: [String: Any] = ["CFBundleIdentifier": "app.cmdpalm.tests.tool", "CFBundleName": "Tool", "CFBundlePackageType": "APPL"]
        try (info as NSDictionary).write(to: app.appending(path: "Info.plist"))

        #expect(AppCatalog.apps(in: root) == ["Tool"])
        #expect(AppCatalog.apps(in: root.appending(path: "missing")) == nil)

        let custom = AppCatalog()
        custom.setCustomFolders([root.path, "/Volumes/cmdpalm-not-connected"])
        #expect(custom.list().contains { $0.id == "app.cmdpalm.tests.tool" && $0.name == "Tool" })
        custom.setCustomFolders([])
        #expect(!custom.list().contains { $0.id == "app.cmdpalm.tests.tool" })
    }

    @Test func unknownAppsHaveNoIconOrAction() {
        #expect(catalog.icon(id: "invalid.cmdpalm.nothing", size: 64) == nil)
        #expect(catalog.perform(id: "invalid.cmdpalm.nothing", op: .open) == false)
    }
}

@Suite @MainActor struct KeyboardLayoutTests {
    @Test func readsTheActiveLayout() throws {
        let layout = try #require(KeyboardLayouts.current())
        #expect(!layout.id.isEmpty)
        #expect(layout.keys.count > 40)
        // Every layout has a space-free, printable base level for most keys.
        #expect(layout.keys.filter { !$0.base.isEmpty }.count > 40)
        #expect(layout.keys.allSatisfy { !$0.base.contains("\r") && !$0.base.contains("\t") })
        #expect(!layout.keys.contains { [0x24, 0x30, 0x31].contains($0.code) })
    }
}

@Suite @MainActor struct PreferencesTests {
    @Test func rejectsPrivilegedAndInvalidPorts() {
        #expect(Preferences.validPort(80) == nil)
        #expect(Preferences.validPort(0) == nil)
        #expect(Preferences.validPort(70_000) == nil)
        #expect(Preferences.validPort(1024) == 1024)
        #expect(Preferences.validPort(8790) == 8790)
    }

    @Test func storesChangesAndNotifies() throws {
        let suite = "app.cmdpalm.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let preferences = Preferences(defaults: defaults)
        #expect(preferences.port == Preferences.defaultPort)
        #expect(preferences.allowShell == false)
        var changes = 0
        preferences.onChange = { changes += 1 }
        preferences.port = 9000
        preferences.allowShell = true
        preferences.onboarded = true
        #expect(changes == 2)

        let reloaded = Preferences(defaults: defaults)
        #expect(reloaded.port == 9000)
        #expect(reloaded.allowShell)
        #expect(reloaded.onboarded)
    }

    @Test func keepsAppFoldersUniqueAndAbsolute() throws {
        let suite = "app.cmdpalm.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(Preferences.uniqueFolders(["/Volumes/A/", "relative", "/Volumes/A", "/Volumes/B/../C"]) == ["/Volumes/A", "/Volumes/C"])

        let preferences = Preferences(defaults: defaults)
        var changes = 0
        preferences.onAppFoldersChange = { changes += 1 }
        preferences.addAppFolder(URL(fileURLWithPath: "/Volumes/Apps"))
        preferences.addAppFolder(URL(fileURLWithPath: "/Volumes/Apps/"))
        #expect(preferences.appFolders == ["/Volumes/Apps"])
        #expect(Preferences(defaults: defaults).appFolders == ["/Volumes/Apps"])
        preferences.removeAppFolder("/Volumes/Apps")
        #expect(preferences.appFolders.isEmpty)
        #expect(changes == 3)
    }
}

@Suite @MainActor struct LinkAddressTests {
    @Test func picksTheHostForEachChoice() {
        let addresses = ["192.168.1.5", "10.0.0.2"]
        #expect(Preferences.LinkAddress.hostName.host(hostName: "Studio.local.", addresses: addresses) == "Studio.local")
        #expect(Preferences.LinkAddress.hostName.host(hostName: "  ", addresses: addresses) == nil)
        #expect(Preferences.LinkAddress.ipAddress.host(hostName: "Studio.local", addresses: addresses) == "192.168.1.5")
        #expect(Preferences.LinkAddress.ipAddress.host(hostName: "Studio.local", addresses: []) == nil)
        #expect(Preferences.LinkAddress.custom.host(hostName: "Studio.local", addresses: addresses, custom: " https://mac.example.com ") == "https://mac.example.com")
        #expect(Preferences.LinkAddress.custom.host(hostName: "Studio.local", addresses: addresses, custom: "  ") == nil)
    }

    @Test func customAddressReachesTheCore() throws {
        let suite = "app.cmdpalm.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = Preferences(defaults: defaults)
        preferences.linkAddress = .custom
        preferences.customLinkAddress = "https://mac.example.com"
        #expect(preferences.linkHost == .custom(address: "https://mac.example.com"))
        #expect(!preferences.allowLocalProxy, "proxies are trusted only when turned on")
        preferences.allowLocalProxy = true
        let reloaded = Preferences(defaults: defaults)
        #expect(reloaded.linkAddress == .custom)
        #expect(reloaded.customLinkAddress == "https://mac.example.com")
        #expect(reloaded.allowLocalProxy)
    }

    @Test func labelsIncludeTheHostWhenKnown() {
        #expect(Preferences.LinkAddress.hostName.label(hostName: "Studio.local", addresses: []) == "Mac Name (Studio.local)")
        #expect(Preferences.LinkAddress.ipAddress.label(hostName: "Studio.local", addresses: ["192.168.1.5"]) == "IP Address (192.168.1.5)")
        #expect(Preferences.LinkAddress.ipAddress.label(hostName: "Studio.local", addresses: []) == "IP Address")
    }

    @Test func defaultsToTheMacName() throws {
        let suite = "app.cmdpalm.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(Preferences(defaults: defaults).linkAddress == .hostName)
    }
}

@Suite struct DeviceTextTests {
    @Test func showsTheTimeTodayAndTheDateBefore() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let now = Date(timeIntervalSince1970: 1_767_268_800)
        let earlier = now.addingTimeInterval(-60)
        let lastWeek = now.addingTimeInterval(-7 * 86_400)
        #expect(DeviceText.connectedSince(earlier, now: now, calendar: calendar).hasPrefix("Since "))
        #expect(DeviceText.connectedSince(earlier, now: now, calendar: calendar) == "Since \(earlier.formatted(date: .omitted, time: .shortened))")
        #expect(DeviceText.connectedSince(lastWeek, now: now, calendar: calendar) == "Since \(lastWeek.formatted(.dateTime.month(.abbreviated).day()))")
    }
}

@Suite struct SystemActionsTests {
    @Test func refusesLocalAndScriptURLs() {
        #expect(SystemActions.open("file:///etc/passwd") == false)
        #expect(SystemActions.open("javascript:alert(1)") == false)
        #expect(SystemActions.open("javascript:alert(1)", allowFiles: true) == false)
        #expect(SystemActions.open("data:text/html,hi", allowFiles: true) == false)
        #expect(SystemActions.open("not a url") == false)
        #expect(SystemActions.runShortcut("   ") == false)
    }
}

@Suite @MainActor struct QRCodeTests {
    @Test func encodesPairingLinks() throws {
        let image = try #require(QRCodeView.image(for: "http://Studio.local:8790/#pair=abcdefghijklmnop"))
        #expect(image.width == image.height)
        #expect(QRCodeView.image(for: "") == nil)
    }
}
