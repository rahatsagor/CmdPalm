import SwiftUI

struct AdvancedPane: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences

    var body: some View {
        @Bindable var preferences = preferences
        Form {
            Section("Server") {
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        StatusDot(color: statusColor)
                        Text(statusText)
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                }
                if let pairing = host.pairing, host.isRunning, !pairing.addresses.isEmpty {
                    LabeledContent(pairing.addresses.count == 1 ? "IP address" : "IP addresses") {
                        Text(pairing.addresses.joined(separator: "\n"))
                            .font(.body.monospaced())
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent {
                    Button("Restart Server") { host.restart() }
                } label: {
                    Text("Restart the server")
                    Text("Every device disconnects briefly and reconnects on its own.")
                }
            }

            Section("Troubleshooting") {
                Picker(selection: $preferences.logLevel) {
                    ForEach(Preferences.LogLevel.allCases) { level in
                        Text(level.title).tag(level)
                    }
                } label: {
                    Text("Log detail")
                    Text("Takes effect the next time CmdPalm opens.")
                }
                LabeledContent {
                    HStack {
                        Button("Show Log") {
                            NSWorkspace.shared.activateFileViewerSelecting([SystemInfo.logFile])
                        }
                        Button("Show Data Folder") {
                            NSWorkspace.shared.open(SystemInfo.dataDirectory)
                        }
                    }
                } label: {
                    Text("Files")
                    Text("Logs never contain what you type.")
                }
                LabeledContent {
                    Button("Show Guide") { WelcomeWindowController.show() }
                } label: {
                    Text("Welcome guide")
                    Text("Walks through permissions and pairing again.")
                }
            }
        }
        .settingsForm()
    }

    private var statusText: String {
        switch host.status {
        case .starting: "Starting…"
        case .stopped: "Stopped"
        case let .failed(message): "Couldn’t start: \(message)"
        case let .running(port): host.paused ? "Paused on port \(String(port))" : "Running on port \(String(port))"
        }
    }

    private var statusColor: Color {
        switch host.status {
        case .running: host.paused ? .orange : .green
        case .starting: .yellow
        case .stopped: .gray
        case .failed: .red
        }
    }
}
