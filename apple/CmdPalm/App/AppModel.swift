import SwiftUI

/// The app's long-lived objects, shared by the menu and every window.
@MainActor
final class AppModel {
    static let shared = AppModel()

    let preferences = Preferences()
    let permissions = Permissions()
    let updater = Updater()
    let loginItem = LoginItem()
    let host: HostController

    private init() {
        host = HostController(preferences: preferences, permissions: permissions)
    }
}

extension View {
    func appEnvironment(_ model: AppModel = .shared) -> some View {
        environment(model.host)
            .environment(model.preferences)
            .environment(model.permissions)
            .environment(model.updater)
            .environment(model.loginItem)
    }
}
