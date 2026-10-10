import Speech
import SwiftUI

struct GeneralPane: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences
    @Environment(Permissions.self) private var permissions
    @Environment(LoginItem.self) private var loginItem
    @Environment(Updater.self) private var updater

    var body: some View {
        @Bindable var preferences = preferences
        Form {
            Section {
                DescribedToggle(
                    "Allow control from devices",
                    detail: "Turn off to ignore input from all devices without disconnecting them.",
                    isOn: Binding(get: { !host.paused }, set: { host.setPaused(!$0) })
                )
                .disabled(!host.isRunning)
                DescribedToggle(
                    "Open at login",
                    detail: "Start CmdPalm in the menu bar when you log in.",
                    isOn: Binding(get: { loginItem.isEnabled }, set: { loginItem.set($0) })
                )
                if loginItem.needsApproval {
                    LabeledContent("CmdPalm won’t open at login until you allow it in Login Items.") {
                        Button("Open Login Items") { loginItem.openSettings() }
                    }
                    .font(.caption)
                }
                if let error = loginItem.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }

            Section("Permissions") {
                PermissionRow(
                    title: "Accessibility",
                    detail: "Lets CmdPalm move the pointer, click and type. Required.",
                    granted: permissions.canControl,
                    action: "Open Settings…"
                ) { permissions.requestControl() }
                if !permissions.canControl {
                    Text("If CmdPalm is already listed and turned on, select it, remove it with the – button, then add it again. This can happen after updating to a differently signed build.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                PermissionRow(
                    title: "Speech Recognition",
                    detail: "Turns speech from your phone’s microphone into text. Optional.",
                    granted: permissions.speech == .authorized,
                    action: permissions.speech == .notDetermined ? "Allow…" : "Open Settings…"
                ) { permissions.requestSpeech() }
            }

            Section("Dictation") {
                DescribedToggle(
                    "Allow dictation from devices",
                    detail: "Your phone streams microphone audio to this Mac, which transcribes it on the Mac. Speech is never sent anywhere else. Needs the encrypted connection from Phone Setup.",
                    isOn: $preferences.voiceEnabled
                )
            }

            AppFoldersSection()

            Section("Updates") {
                if updater.isConfigured {
                    Toggle("Check for updates automatically", isOn: Binding(get: { updater.automaticallyChecks }, set: { updater.automaticallyChecks = $0 }))
                    Toggle("Download and install updates automatically", isOn: Binding(get: { updater.automaticallyDownloads }, set: { updater.automaticallyDownloads = $0 }))
                        .disabled(!updater.automaticallyChecks)
                    LabeledContent {
                        Button("Check Now") { updater.checkForUpdates() }
                            .disabled(!updater.canCheck)
                    } label: {
                        Text("Version \(SystemInfo.appVersion)")
                        if let last = updater.lastChecked {
                            Text("Last checked \(last.formatted(.relative(presentation: .named)))")
                        }
                    }
                } else {
                    LabeledContent("Version \(SystemInfo.appVersion)") {
                        Text("Updates are off in development builds.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .settingsForm()
        .onAppear {
            loginItem.refresh()
            permissions.refresh()
        }
    }
}
