import Foundation
import Observation

/// User settings stored in UserDefaults. Changing one that affects the host
/// calls `onChange` so the controller can push a new configuration.
@MainActor
@Observable
final class Preferences {
    static let defaultPort = 8790

    enum LinkAddress: String, CaseIterable, Identifiable {
        case hostName
        case ipAddress
        case custom
        var id: Self { self }

        var title: String {
            switch self {
            case .hostName: "Mac Name"
            case .ipAddress: "IP Address"
            case .custom: "Custom"
            }
        }

        /// The host a phone would open for this choice, such as `Studio.local`
        /// or `192.168.1.5`, or nil when the Mac has none.
        func host(hostName: String, addresses: [String], custom: String = "") -> String? {
            switch self {
            case .hostName:
                var name = hostName.trimmingCharacters(in: .whitespacesAndNewlines)
                while name.hasSuffix(".") { name.removeLast() }
                return name.isEmpty ? nil : name
            case .ipAddress:
                return addresses.first { !$0.isEmpty }
            case .custom:
                let address = custom.trimmingCharacters(in: .whitespacesAndNewlines)
                return address.isEmpty ? nil : address
            }
        }

        func label(hostName: String, addresses: [String], custom: String = "") -> String {
            guard let host = host(hostName: hostName, addresses: addresses, custom: custom) else {
                return title
            }
            return "\(title) (\(host))"
        }
    }

    enum LogLevel: String, CaseIterable, Identifiable {
        case warn, info, debug, trace
        var id: Self { self }

        var title: String {
            switch self {
            case .warn: "Warnings only"
            case .info: "Normal"
            case .debug: "Detailed"
            case .trace: "Everything"
            }
        }
    }

    private enum Key {
        static let port = "port"
        static let linkAddress = "linkAddress"
        static let customLinkAddress = "customLinkAddress"
        static let allowLocalProxy = "allowLocalProxy"
        static let allowPin = "allowPin"
        static let allowApproval = "allowApproval"
        static let allowShell = "allowShell"
        static let voiceEnabled = "voiceEnabled"
        static let logLevel = "logLevel"
        static let onboarded = "onboarded"
        static let appFolders = "appFolders"
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored var onAppFoldersChange: (() -> Void)?

    var port: Int { didSet { save(port, Key.port) } }
    var linkAddress: LinkAddress { didSet { save(linkAddress.rawValue, Key.linkAddress) } }
    /// The address the QR code uses when `linkAddress` is `.custom`: another
    /// of the Mac's addresses, a name from the person's own DNS, or a URL
    /// such as `https://mac.example.com` for a reverse proxy.
    var customLinkAddress: String { didSet { save(customLinkAddress, Key.customLinkAddress) } }
    /// Trust a reverse proxy on this Mac to say which device is connecting.
    var allowLocalProxy: Bool { didSet { save(allowLocalProxy, Key.allowLocalProxy) } }
    var allowPin: Bool { didSet { save(allowPin, Key.allowPin) } }
    var allowApproval: Bool { didSet { save(allowApproval, Key.allowApproval) } }
    var allowShell: Bool { didSet { save(allowShell, Key.allowShell) } }
    var voiceEnabled: Bool { didSet { save(voiceEnabled, Key.voiceEnabled) } }
    var logLevel: LogLevel { didSet { save(logLevel.rawValue, Key.logLevel, notify: false) } }
    var onboarded: Bool { didSet { save(onboarded, Key.onboarded, notify: false) } }
    /// Extra folders to look for apps in, such as one on an external drive.
    var appFolders: [String] {
        didSet {
            save(appFolders, Key.appFolders, notify: false)
            onAppFoldersChange?()
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.port: Self.defaultPort,
            Key.linkAddress: LinkAddress.hostName.rawValue,
            Key.allowLocalProxy: false,
            Key.allowPin: true,
            Key.allowApproval: true,
            Key.allowShell: false,
            Key.voiceEnabled: true,
            Key.logLevel: LogLevel.info.rawValue,
            Key.onboarded: false,
        ])
        port = Self.validPort(defaults.integer(forKey: Key.port)) ?? Self.defaultPort
        linkAddress = LinkAddress(rawValue: defaults.string(forKey: Key.linkAddress) ?? "") ?? .hostName
        customLinkAddress = defaults.string(forKey: Key.customLinkAddress) ?? ""
        allowLocalProxy = defaults.bool(forKey: Key.allowLocalProxy)
        allowPin = defaults.bool(forKey: Key.allowPin)
        allowApproval = defaults.bool(forKey: Key.allowApproval)
        allowShell = defaults.bool(forKey: Key.allowShell)
        voiceEnabled = defaults.bool(forKey: Key.voiceEnabled)
        logLevel = LogLevel(rawValue: defaults.string(forKey: Key.logLevel) ?? "") ?? .info
        onboarded = defaults.bool(forKey: Key.onboarded)
        appFolders = Self.uniqueFolders(defaults.stringArray(forKey: Key.appFolders) ?? [])
    }

    var linkHost: LinkHost {
        switch linkAddress {
        case .hostName: .hostName
        case .ipAddress: .ipAddress
        case .custom: .custom(address: customLinkAddress)
        }
    }

    static let maxAppFolders = 32

    func addAppFolder(_ url: URL) {
        appFolders = Self.uniqueFolders(appFolders + [url.path])
    }

    func removeAppFolder(_ path: String) {
        appFolders.removeAll { $0 == path }
    }

    /// Absolute, standardized, de-duplicated paths in their original order.
    static func uniqueFolders(_ paths: [String]) -> [String] {
        var result: [String] = []
        for path in paths where path.hasPrefix("/") {
            let standard = URL(fileURLWithPath: path).standardizedFileURL.path
            if !result.contains(standard) { result.append(standard) }
        }
        return Array(result.prefix(maxAppFolders))
    }

    /// Ports below 1024 need root; 0 would pick a different port every launch.
    static func validPort(_ value: Int) -> Int? {
        (1024...65535).contains(value) ? value : nil
    }

    private func save(_ value: Any, _ key: String, notify: Bool = true) {
        defaults.set(value, forKey: key)
        if notify { onChange?() }
    }
}
