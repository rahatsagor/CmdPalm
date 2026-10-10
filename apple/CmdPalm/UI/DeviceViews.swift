import AppKit
import SwiftUI

enum DeviceSymbol {
    static func name(for model: String) -> String {
        let model = model.lowercased()
        if model.contains("ipad") || model.contains("tablet") { return "ipad" }
        if model.contains("iphone") || model.contains("android") || model.contains("phone") { return "iphone" }
        if model.contains("mac") || model.contains("windows") || model.contains("linux") { return "laptopcomputer" }
        return "iphone"
    }
}

enum DeviceText {
    /// A fixed time rather than "5 minutes ago", so the row never needs a
    /// timer to stay correct.
    static func connectedSince(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return "Since \(date.formatted(date: .omitted, time: .shortened))"
        }
        return "Since \(date.formatted(.dateTime.month(.abbreviated).day()))"
    }

    static let removeMessage = "It is disconnected and must pair again with a QR code, PIN or approval. Its phone settings kept on this Mac, such as custom keyboards and gestures, are deleted."

    @MainActor
    static func confirmRemove(_ device: TrustedDevice, host: HostController) {
        let alert = NSAlert()
        alert.messageText = "Remove “\(device.name)”?"
        alert.informativeText = removeMessage
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Remove Device").hasDestructiveAction = true
        alert.addButton(withTitle: "Cancel")
        if AppActivation.shared.present({ alert.runModal() }) == .alertFirstButtonReturn {
            host.forget(device)
        }
    }
}

struct DeviceIcon: View {
    let model: String
    var online = false

    var body: some View {
        Image(systemName: DeviceSymbol.name(for: model))
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: 17))
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                if online {
                    StatusDot(color: .green)
                        .offset(x: 2, y: 2)
                }
            }
            .accessibilityHidden(true)
    }
}

/// A connected device in the menu bar panel. The disconnect button appears
/// on hover or keyboard focus to keep the list calm.
struct ConnectedDeviceRow: View {
    @Environment(HostController.self) private var host
    let device: ConnectedDevice
    @State private var hovering = false
    @FocusState private var buttonFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            ConnectedDeviceLabel(device: device)
                .accessibilityElement(children: .combine)
                .accessibilityAction(named: "Disconnect") { host.disconnect(device) }
            Spacer(minLength: 4)
            Button {
                host.disconnect(device)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .focused($buttonFocused)
            .opacity(hovering || buttonFocused ? 1 : 0)
            .help("Disconnect — the device can reconnect from the phone")
            .accessibilityLabel("Disconnect \(device.name)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .background(HoverBackground(active: hovering))
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Disconnect") { host.disconnect(device) }
            if device.remembered, let trusted = host.trusted.first(where: { $0.id == device.deviceId }) {
                Divider()
                Button("Remove Device…") {
                    // Let the context menu finish closing before the modal alert starts.
                    Task { @MainActor in DeviceText.confirmRemove(trusted, host: host) }
                }
            }
        }
    }
}

struct ConnectedDeviceLabel: View {
    let device: ConnectedDevice

    var body: some View {
        HStack(spacing: 10) {
            DeviceIcon(model: device.model, online: true)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if device.secure {
                        Image(systemName: "lock.fill")
                            .imageScale(.small)
                            .help("Encrypted connection")
                            .accessibilityLabel("Encrypted")
                    }
                    Text(detail)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
    }

    private var detail: String {
        let since = DeviceText.connectedSince(Date(timeIntervalSince1970: TimeInterval(device.connectedAt)))
        return device.model.isEmpty ? since : "\(device.model) · \(since)"
    }
}

struct ApprovalRow: View {
    @Environment(HostController.self) private var host
    let request: ApprovalRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: DeviceSymbol.name(for: request.model))
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: 17))
                    .foregroundStyle(.tint)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text("“\(request.deviceName)” wants to connect")
                        .font(.callout.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                Spacer()
                Button("Don’t Allow") { host.respond(to: request, allow: false) }
                Button("Allow") { host.respond(to: request, allow: true) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .padding(12)
        .cardBackground(tint: .accentColor)
    }

    private var detail: String {
        let parts = [request.model, request.address].filter { !$0.isEmpty }
        let source = parts.isEmpty ? "" : parts.joined(separator: " · ") + ". "
        return source + "Only allow devices you recognize."
    }
}
