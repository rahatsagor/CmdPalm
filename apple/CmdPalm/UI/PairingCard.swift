import SwiftUI

struct PairingCard: View {
    @Environment(HostController.self) private var host
    var qrSize: CGFloat = 176

    var body: some View {
        VStack(spacing: 12) {
            if let pairing = host.pairing, host.isRunning {
                QRCodeView(text: pairing.link, size: qrSize)
                Text("Scan with your phone’s camera")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                VStack(spacing: 0) {
                    if host.preferences.allowPin {
                        PinRow(pin: pairing.pin, expiry: host.pairingExpiry) { host.renewPairing() }
                        Divider().padding(.horizontal, 12)
                    }
                    AddressRow(address: pairing.address)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .cardBackground()
                LinkAddressPicker(pairing: pairing)
            } else {
                ServerStatusPlaceholder()
                    .frame(height: qrSize)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct PinRow: View {
    let pin: String
    let expiry: Date
    let renew: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Or enter this PIN")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(Self.format(pin))
                    .font(.system(size: 22, weight: .semibold, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("PIN \(pin.map(String.init).joined(separator: " "))")
            }
            Spacer(minLength: 8)
            countdown
            Button(action: renew) {
                Image(systemName: "arrow.clockwise")
                    .fontWeight(.medium)
            }
            .buttonStyle(.borderless)
            .help("Make a new QR code and PIN")
            .accessibilityLabel("New QR code and PIN")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .reportsPinVisibility()
    }

    /// A system-driven timer text, which is cheaper than redrawing the row
    /// every second.
    private var countdown: some View {
        let now = Date.now
        return Text(timerInterval: min(now, expiry)...expiry, countsDown: true, showsHours: false)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .frame(minWidth: 32, alignment: .trailing)
            .help("The QR code and PIN change when this reaches zero.")
    }

    static func format(_ pin: String) -> String {
        guard pin.count == 6 else { return pin }
        return "\(pin.prefix(3)) \(pin.suffix(3))"
    }
}

extension View {
    /// Tells the host while this view is on screen, as the core only accepts
    /// the PIN then.
    func reportsPinVisibility() -> some View {
        background(PinVisibility())
    }
}

private struct PinVisibility: View {
    @Environment(HostController.self) private var host

    var body: some View {
        WindowVisibility { host.pinShown($0) }
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
    }
}

/// Reports whether its window is on screen. Menu bar panel content can stay
/// alive while the panel is closed, so `onDisappear` alone isn't reliable.
struct WindowVisibility: NSViewRepresentable {
    let changed: @MainActor (Bool) -> Void

    func makeNSView(context: Context) -> VisibilityView {
        VisibilityView(changed: changed)
    }

    func updateNSView(_ view: VisibilityView, context: Context) {}

    static func dismantleNSView(_ view: VisibilityView, coordinator: ()) {
        view.stop()
    }

    final class VisibilityView: NSView {
        private let changed: @MainActor (Bool) -> Void
        private var visible = false
        private var observers: [NSObjectProtocol] = []

        init(changed: @escaping @MainActor (Bool) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeObservers()
            if let window {
                let center = NotificationCenter.default
                observers.append(center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.update() }
                })
                observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.report(false) }
                })
            }
            update()
        }

        func stop() {
            removeObservers()
            report(false)
        }

        private func update() {
            report(window.map { $0.isVisible && $0.occlusionState.contains(.visible) } ?? false)
        }

        private func report(_ shown: Bool) {
            guard shown != visible else { return }
            visible = shown
            changed(shown)
        }

        private func removeObservers() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
        }
    }
}

struct AddressRow: View {
    let address: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "link")
                .imageScale(.small)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            Text(address)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 4)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(address, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .contentTransition(.symbolEffect(.replace))
                    .foregroundStyle(copied ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.borderless)
            .help("Copy address")
            .accessibilityLabel(copied ? "Copied" : "Copy address")
        }
    }
}

struct LinkAddressPicker: View {
    @Environment(Preferences.self) private var preferences
    let pairing: PairingInfo

    var body: some View {
        @Bindable var preferences = preferences
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    title
                    Spacer(minLength: 8)
                    picker($preferences.linkAddress)
                }
                VStack(alignment: .leading, spacing: 6) {
                    title
                    picker($preferences.linkAddress)
                }
            }
            Text(hint)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    private var title: some View {
        Text("QR link uses")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    private func picker(_ selection: Binding<Preferences.LinkAddress>) -> some View {
        Picker("Address in the QR code", selection: selection) {
            ForEach(options) { option in
                Text(option.title).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .help(options
            .map { pairing.label(for: $0, preferences: preferences) }
            .joined(separator: "\n"))
    }

    /// Custom is set up in Settings, so the menu only offers it once chosen.
    private var options: [Preferences.LinkAddress] {
        Preferences.LinkAddress.allCases.filter { $0 != .custom || preferences.linkAddress == .custom }
    }

    private var hint: String {
        switch preferences.linkAddress {
        case .hostName:
            "Some Android phones can’t open .local names. If scanning doesn’t open CmdPalm, choose IP Address."
        case .ipAddress:
            "The IP address can change when this Mac rejoins the network. Mac Name keeps working."
        case .custom:
            "Change the custom address in Settings → Phone Setup."
        }
    }
}

extension PairingInfo {
    @MainActor func label(for option: Preferences.LinkAddress, preferences: Preferences) -> String {
        option.label(
            hostName: SystemInfo.bonjourHostName,
            addresses: addresses,
            custom: preferences.customLinkAddress
        )
    }
}

/// Without a network, a QR code would point the phone at itself.
private struct NoNetworkPlaceholder: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "wifi.slash")
                .symbolRenderingMode(.hierarchical)
                .font(.title)
                .foregroundStyle(.secondary)
            Text("Not connected to a network")
                .font(.headline)
            Text("Connect this Mac to Wi-Fi or Ethernet, and the QR code appears here.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }
}

struct ServerStatusPlaceholder: View {
    @Environment(HostController.self) private var host

    var body: some View {
        VStack(spacing: 8) {
            switch host.status {
            case .starting:
                ProgressView().controlSize(.small)
                Text("Starting…").foregroundStyle(.secondary)
            case let .failed(message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.title)
                    .foregroundStyle(.orange)
                Text("CmdPalm couldn’t start")
                    .font(.headline)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { host.restart() }
                    .controlSize(.small)
            case .stopped, .running:
                Image(systemName: "pause.circle")
                    .symbolRenderingMode(.hierarchical)
                    .font(.title)
                    .foregroundStyle(.secondary)
                Text("Not accepting connections").foregroundStyle(.secondary)
                Button("Start") { host.start() }
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
    }
}
