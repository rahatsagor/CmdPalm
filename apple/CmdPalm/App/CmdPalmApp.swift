import SwiftUI

@main
struct CmdPalmApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        AppDelegate.handOffToRunningCopy()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuPanel()
                .appEnvironment()
        } label: {
            MenuBarIcon()
                .appEnvironment()
        }
        .menuBarExtraStyle(.window)
    }
}
