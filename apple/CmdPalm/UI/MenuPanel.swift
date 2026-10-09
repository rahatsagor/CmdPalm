import SwiftUI

struct MenuBarIcon: View {
    @Environment(HostController.self) private var host
    @Environment(Permissions.self) private var permissions

    var body: some View {
        Image(systemName: symbol)
            .accessibilityLabel(accessibilityLabel)
    }

    private var symbol: String {
        if !host.approvals.isEmpty { return "bell.badge" }
        switch host.status {
        case .failed: return "exclamationmark.triangle"
        case .stopped: return "command.square"
        default: break
        }
        if host.paused { return "pause.circle" }
        if !permissions.canControl { return "exclamationmark.triangle" }
        return host.connected.isEmpty ? "command" : "command.circle.fill"
    }

    private var accessibilityLabel: String {
        if !host.approvals.isEmpty { return "CmdPalm, a device is asking to pair" }
        if case .failed = host.status { return "CmdPalm, not running" }
        if host.paused { return "CmdPalm, paused" }
        if !permissions.canControl { return "CmdPalm, needs Accessibility permission" }
        return host.connected.isEmpty ? "CmdPalm" : "CmdPalm, connected"
    }
}

struct MenuPanel: View {
    @Environment(HostController.self) private var host
    @Environment(Permissions.self) private var permissions
    @Environment(Updater.self) private var updater
    @State private var showPairing = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                alerts
                ForEach(host.approvals, id: \.id) { request in
                    ApprovalRow(request: request)
                }
                if !host.connected.isEmpty {
                    devices
                }
                if host.connected.isEmpty || showPairing {
                    pairing
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            Divider()
            footer
                .padding(6)
        }
        .frame(width: 320)
        .animation(.snappy(duration: 0.2), value: showPairing)
        .animation(.snappy(duration: 0.2), value: host.connected)
        .onAppear {
            if host.isRunning { host.refreshPairing() }
            permissions.refresh()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("CmdPalm")
                    .font(.headline)
                HStack(spacing: 6) {
                    StatusDot(color: statusColor, size: 7)
                    Text(statusText)
                        .lineLimit(1)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if host.isRunning {
                Toggle(isOn: Binding(get: { !host.paused }, set: { host.setPaused(!$0) })) {
                    Text("Allow control")
                }
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(host.paused ? "Resume control from devices" : "Pause control from all devices")
                .accessibilityLabel("Allow control from devices")
            }
        }
    }

    @ViewBuilder
    private var alerts: some View {
        if !permissions.canControl {
            Callout(symbol: "hand.raised.fill", tint: .orange,
                    title: "Allow CmdPalm to control this Mac",
                    message: "Turn on CmdPalm in Privacy & Security → Accessibility.") {
                Button("Open Settings") { permissions.requestControl() }
            }
        }
        if let version = updater.pendingVersion {
            Callout(symbol: "arrow.down.circle.fill", tint: .accentColor,
                    title: "CmdPalm \(version) is available", message: nil) {
                Button("Update") { updater.checkForUpdates() }
            }
        }
        if let notice = host.notice, permissions.canControl {
            Callout(symbol: "info.circle.fill", tint: .secondary, title: notice, message: nil) {
                Button("Dismiss") { host.notice = nil }
            }
        }
        if host.preferredPortTaken, let port = host.port {
            Label("Port \(String(host.preferences.port)) is in use by another app, so CmdPalm is using \(String(port)).",
                  systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }

    private var devices: some View {
        VStack(alignment: .leading, spacing: 6) {
            MenuSectionHeader(host.connected.count == 1 ? "Connected Device" : "Connected Devices") {
                Button {
                    showPairing.toggle()
                } label: {
                    Label(showPairing ? "Hide QR Code" : "Pair Another", systemImage: showPairing ? "chevron.up" : "plus")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.borderless)
                .font(.caption.weight(.medium))
                .foregroundStyle(.tint)
            }
            VStack(spacing: 0) {
                ForEach(host.connected, id: \.session) { device in
                    ConnectedDeviceRow(device: device)
                }
            }
            .padding(4)
            .cardBackground()
        }
    }

    private var pairing: some View {
        VStack(alignment: .leading, spacing: 8) {
            MenuSectionHeader(host.connected.isEmpty ? "Connect a Device" : "Pair Another Device")
            PairingCard()
        }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Button {
                SettingsWindowController.show()
            } label: {
                MenuRowLabel(title: "Settings…", symbol: "gearshape", shortcut: "⌘,")
            }
            .keyboardShortcut(",")
            Button {
                NSApp.terminate(nil)
            } label: {
                MenuRowLabel(title: "Quit CmdPalm", symbol: "power", shortcut: "⌘Q")
            }
            .keyboardShortcut("q")
        }
        .buttonStyle(MenuRowButtonStyle())
    }

    private var statusText: String {
        switch host.status {
        case .starting: return "Starting…"
        case .stopped: return "Off"
        case .failed: return "Couldn’t start"
        case .running:
            if host.paused { return "Paused" }
            switch host.connected.count {
            case 0: return "Ready to connect"
            case 1: return "\(host.connected[0].name) connected"
            case let count: return "\(count) devices connected"
            }
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

struct Callout<Actions: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    let message: String?
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 17))
                .foregroundStyle(tint)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) { actions() }
                    .controlSize(.small)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .cardBackground(tint: tint)
    }
}
