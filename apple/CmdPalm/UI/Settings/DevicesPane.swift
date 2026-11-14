import SwiftUI

struct DevicesPane: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences
    @Environment(Permissions.self) private var permissions
    @State private var confirmForgetAll = false

    var body: some View {
        Form {
            Section("Screen Viewing") {
                VStack(alignment: .leading, spacing: 8) {
                    if !preferences.displayEnabled {
                        Label("Screen viewing is off on this Mac", systemImage: "display")
                    } else if !permissions.canView {
                        Label("Screen Recording permission is needed", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                    } else {
                        Label("Ready to share a display", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    Text("Turn on Allow screen viewing for each device below. Devices without this access can still use the trackpad and keyboard.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        if preferences.displayEnabled && !permissions.canView {
                            Button("Allow Screen Recording…") { permissions.requestViewing() }
                                .fixedSize()
                        }
                        Button("Display Settings…") { SettingsNavigation.shared.selection = .general }
                            .fixedSize()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
            Section("Connected Now") {
                if host.connected.isEmpty {
                    Text("No devices are connected right now.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(host.connected, id: \.session) { device in
                        ConnectedSettingsRow(device: device)
                    }
                }
            }

            Section {
                if host.trusted.isEmpty {
                    Text("Devices you pair appear here. They reconnect without a code until you remove them.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(host.trusted, id: \.id) { device in
                        TrustedDeviceRow(device: device, session: host.connected.first { $0.remembered && $0.deviceId == device.id })
                    }
                }
            } header: {
                Text("Paired Devices")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Each device’s phone settings, such as custom keyboards and gestures, are kept on this Mac and deleted when you remove the device.")
                        .fixedSize(horizontal: false, vertical: true)
                    if !host.trusted.isEmpty {
                        HStack {
                            Spacer()
                            Button("Remove All…", role: .destructive) { confirmForgetAll = true }
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .settingsForm()
        .confirmationDialog("Remove all paired devices?", isPresented: $confirmForgetAll) {
            Button("Remove All", role: .destructive) { host.forgetAllDevices() }
        } message: {
            Text("They are disconnected and must pair again with a QR code, PIN or approval. Their phone settings kept on this Mac are deleted.")
        }
    }
}

private struct ConnectedSettingsRow: View {
    @Environment(HostController.self) private var host
    let device: ConnectedDevice

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                ConnectedDeviceLabel(device: device)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    .accessibilityElement(children: .combine)
                Button("Disconnect") { host.disconnect(device) }
                    .fixedSize()
                    .help("Disconnect this device; it can reconnect from the phone")
            }
            DeviceScreenAccessRow(name: device.name, temporary: !device.remembered, allowed: Binding(
                get: { device.displayAllowed },
                set: {
                    if device.remembered { host.setDisplayAllowed(device.deviceId, allowed: $0) }
                    else { host.setTemporaryDisplayAllowed(device.session, allowed: $0) }
                }
            ))
            .padding(.leading, 38)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TrustedDeviceRow: View {
    @Environment(HostController.self) private var host
    let device: TrustedDevice
    let session: ConnectedDevice?
    @State private var name = ""
    @State private var renaming = false
    @State private var confirmForget = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                DeviceIcon(model: device.model, online: session != nil)
                    .help(session != nil ? "Connected" : "Not connected")
                VStack(alignment: .leading, spacing: 3) {
                    nameField
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Button("Remove…") { confirmForget = true }
                    .fixedSize()
            }
            DeviceScreenAccessRow(name: device.name, allowed: Binding(get: { device.displayAllowed }, set: { host.setDisplayAllowed(device.id, allowed: $0) }))
                .padding(.leading, 38)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button("Rename") { startRenaming() }
            if let session {
                Button("Disconnect") { host.disconnect(session) }
            }
            Divider()
            Button("Remove…", role: .destructive) { confirmForget = true }
        }
        .onAppear { name = device.name }
        .onChange(of: device.name) { _, new in if !renaming { name = new } }
        .confirmationDialog("Remove “\(device.name)”?", isPresented: $confirmForget) {
            Button("Remove Device", role: .destructive) { host.forget(device) }
        } message: {
            Text(DeviceText.removeMessage)
        }
    }

    @ViewBuilder
    private var nameField: some View {
        if renaming {
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
                .focused($nameFocused)
                .onSubmit(commit)
                .onExitCommand {
                    name = device.name
                    renaming = false
                }
                .onChange(of: nameFocused) { _, focused in
                    if !focused { commit() }
                }
                .onAppear { nameFocused = true }
        } else {
            HStack(spacing: 4) {
                Text(device.name)
                    .lineLimit(1)
                    .help(device.name)
                Button(action: startRenaming) {
                    Image(systemName: "pencil")
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Rename")
                .accessibilityLabel("Rename \(device.name)")
            }
        }
    }

    private func startRenaming() {
        name = device.name
        renaming = true
    }

    private func commit() {
        guard renaming else { return }
        renaming = false
        host.rename(device, to: name)
    }

    private var detail: String {
        var parts: [String] = []
        if !device.model.isEmpty { parts.append(device.model) }
        if session != nil {
            parts.append("Connected")
        } else if device.lastSeen > 0 {
            let date = Date(timeIntervalSince1970: TimeInterval(device.lastSeen))
            parts.append("Last used \(date.formatted(.relative(presentation: .named)))")
        }
        let paired = Date(timeIntervalSince1970: TimeInterval(device.pairedAt))
        parts.append("Paired \(paired.formatted(date: .abbreviated, time: .omitted))")
        return parts.joined(separator: " · ")
    }
}

/// A separate line keeps the form's toggle label sizing from squeezing the
/// device name or destructive action, even at the minimum window width.
private struct DeviceScreenAccessRow: View {
    let name: String
    var temporary = false
    @Binding var allowed: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Allow screen viewing")
                Text(temporary ? "For this connection only" : (allowed ? "Allowed when screen viewing is on" : "Screen viewing is off for this device"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("Allow screen viewing for \(name)", isOn: $allowed)
                .labelsHidden()
                .toggleStyle(.switch)
                .fixedSize()
                .accessibilityLabel("Allow screen viewing for \(name)")
        }
    }
}
