import AppKit
import SwiftUI

/// Tells input from this Mac's own devices apart from the events CmdPalm
/// generates for a phone, so a phone cannot approve itself.
enum InputOrigin {
    static let marker = inputEventMarker()

    static func isFromCmdPalm(_ event: CGEvent?) -> Bool {
        guard let event else { return false }
        return event.getIntegerValueField(.eventSourceUserData) == marker
            || event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
    }

    /// Replaced in tests.
    @MainActor static var current: () -> NSEvent? = { NSApp.currentEvent }

    @MainActor static var currentIsFromCmdPalm: Bool { isFromCmdPalm(current()?.cgEvent) }
}

extension Binding where Value == Bool {
    /// Turning the value on needs input from this Mac; turning it off never does.
    @MainActor func grantedLocally(_ host: HostController) -> Binding<Bool> {
        Binding(get: { wrappedValue }, set: { newValue in
            if !newValue || host.allowsGrant() { wrappedValue = newValue }
        })
    }
}
