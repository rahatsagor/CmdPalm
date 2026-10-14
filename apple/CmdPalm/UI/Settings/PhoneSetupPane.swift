import SwiftUI
import UniformTypeIdentifiers

struct PhoneSetupPane: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences

    var body: some View {
        @Bindable var preferences = preferences
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Step(1, "Join the same Wi-Fi network as this Mac.")
                    Step(2, "Scan the QR code with the phone’s camera, or type the address in its browser and enter the PIN.")
                    Step(3, "Add CmdPalm to the Home Screen to use it full screen: Share → Add to Home Screen on iPhone and iPad, or the browser menu on Android.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                PairingCard(qrSize: 180)
                    .frame(maxWidth: 320)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            } header: {
                Text("Connect a Device")
            }

            Section("Pairing") {
                DescribedToggle(
                    "Allow pairing with a PIN",
                    detail: "Devices can pair by typing the six-digit PIN shown with the QR code. The PIN only works while it’s on screen here, and for a few minutes after. Scanning the QR code always works.",
                    isOn: $preferences.allowPin
                )
                DescribedToggle(
                    "Allow devices to ask to pair",
                    detail: "A device can ask for access without a code, and you approve it on this Mac.",
                    isOn: $preferences.allowApproval
                )
            }

            Section("Network") {
                Picker(selection: $preferences.linkAddress) {
                    ForEach(Preferences.LinkAddress.allCases) { option in
                        Text(option.label(
                            hostName: SystemInfo.bonjourHostName,
                            addresses: host.pairing?.addresses ?? [],
                            custom: preferences.customLinkAddress
                        ))
                        .tag(option)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Address in the QR code")
                        Text("Mac Name keeps working when the IP address changes. Some Android phones can’t open .local names; choose IP Address for them. Custom is for a VPN or a proxy you set up yourself.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if preferences.linkAddress == .custom {
                    CustomAddressField()
                }
                PortField()
            }

            EncryptedConnectionSection()
        }
        .settingsForm()
        .onAppear { if host.isRunning { host.refreshPairing() } }
    }
}

private struct Step: View {
    let number: Int
    let text: String

    init(_ number: Int, _ text: String) {
        self.number = number
        self.text = text
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(.tint, in: Circle())
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PortField: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                TextField("Port", text: $text, prompt: Text(String(Preferences.defaultPort)))
                    .labelsHidden()
                    .frame(width: 70)
                    .multilineTextAlignment(.trailing)
                    .focused($focused)
                    .onSubmit(apply)
                if parsed != preferences.port {
                    Button("Apply", action: apply).disabled(parsed == nil)
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Port")
                Group {
                    if host.preferredPortTaken, let port = host.port {
                        Text("Port \(String(preferences.port)) is in use by another app, so CmdPalm is using \(String(port)).")
                    } else if parsed == nil, !text.isEmpty {
                        Text("Use a number from 1024 to 65535.").foregroundStyle(.red)
                    } else {
                        Text("Devices connect on this port. Changing it changes the pairing link.")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .onAppear { text = String(preferences.port) }
    }

    private var parsed: Int? {
        Int(text.trimmingCharacters(in: .whitespaces)).flatMap(Preferences.validPort)
    }

    private func apply() {
        guard let port = parsed else { return }
        preferences.port = port
        focused = false
    }
}

private struct CustomAddressField: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                TextField("Custom address", text: $text, prompt: Text(verbatim: "mac.example.com"))
                    .labelsHidden()
                    .frame(minWidth: 180)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .onSubmit(apply)
                if let addresses = host.pairing?.addresses, !addresses.isEmpty {
                    Menu {
                        ForEach(addresses, id: \.self) { address in
                            Button(menuTitle(address)) {
                                text = address
                                apply()
                            }
                        }
                    } label: {
                        Image(systemName: "network")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Use one of this Mac’s addresses")
                    .accessibilityLabel("Use one of this Mac’s addresses")
                }
                if trimmed != preferences.customLinkAddress {
                    Button("Apply", action: apply)
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Custom address")
                Text("Another of this Mac’s addresses, such as a VPN’s, a name for this Mac from your own DNS, or the https address of a proxy you set up. Without a port, CmdPalm’s port is added. CmdPalm also accepts connections that use this name.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { text = preferences.customLinkAddress }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func menuTitle(_ address: String) -> String {
        host.pairing?.vpnAddresses.contains(address) == true ? "\(address) (VPN)" : address
    }

    private func apply() {
        preferences.customLinkAddress = trimmed
        focused = false
    }
}

/// Steps for trusting CmdPalm's certificate, which phones need before they
/// allow the microphone and other features on a local address.
private struct EncryptedConnectionSection: View {
    @Environment(HostController.self) private var host
    @State private var platform = Platform.apple

    enum Platform: String, CaseIterable, Identifiable {
        case apple, android
        var id: Self { self }
    }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Dictation and some phone features only work over an encrypted (HTTPS) connection. Install CmdPalm’s certificate on your phone once to turn it on. The certificate was created on this Mac and only covers local network addresses, never websites.")
                    .fixedSize(horizontal: false, vertical: true)
                Label("On Android, installing CmdPalm as an app, rather than a Home Screen shortcut, needs the encrypted connection, because Chrome only installs web apps over HTTPS.",
                      systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Picker("Phone", selection: $platform) {
                Text("iPhone and iPad").tag(Platform.apple)
                Text("Android").tag(Platform.android)
            }
            .pickerStyle(.segmented)

            if let pairing = host.pairing, host.isRunning {
                let certificateLink = "\(pairing.address)/cmdpalm.crt"
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 6) {
                        QRCodeView(text: certificateLink, size: 110, label: "Certificate QR code")
                        Text("Certificate").font(.caption).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(steps(certificateLink).enumerated()), id: \.offset) { index, step in
                            Step(index + 1, step)
                        }
                    }
                }
                .padding(.vertical, 4)

                LabeledContent {
                    VStack(spacing: 6) {
                        QRCodeView(text: secureLink(pairing), size: 110)
                        Text("Encrypted link").font(.caption).foregroundStyle(.secondary)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Then scan this code to pair over the encrypted connection.")
                        AddressRow(address: pairing.secureAddress)
                        if !pairing.caFingerprint.isEmpty {
                            Text("SHA-256 fingerprint: \(pairing.caFingerprint)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            LabeledContent {
                Button("Save Certificate…", action: saveCertificate)
            } label: {
                Text("Certificate file")
                Text("For a device that can’t scan the code.")
            }
        } header: {
            Text("Encrypted Connection")
        }
    }

    private func steps(_ link: String) -> [String] {
        switch platform {
        case .apple:
            [
                "Scan the certificate code, or open \(link) in Safari, and tap Allow.",
                "Open Settings → General → VPN & Device Management, choose the CmdPalm profile and tap Install.",
                "Open Settings → General → About → Certificate Trust Settings and turn on CmdPalm.",
            ]
        case .android:
            [
                "Scan the certificate code, or open \(link) in Chrome, to download it.",
                "Open Settings → Security → More security settings → Encryption & credentials → Install a certificate → CA certificate.",
                "Choose the downloaded cmdpalm.crt file.",
            ]
        }
    }

    private func secureLink(_ pairing: PairingInfo) -> String {
        guard let fragment = pairing.link.range(of: "/#") else { return pairing.secureAddress }
        return pairing.secureAddress + pairing.link[fragment.lowerBound...]
    }

    private func saveCertificate() {
        let data = host.certificate()
        guard !data.isEmpty else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "CmdPalm.crt"
        panel.allowedContentTypes = [UTType(filenameExtension: "crt") ?? .x509Certificate]
        AppActivation.shared.present {
            if panel.runModal() == .OK, let url = panel.url {
                try? data.write(to: url)
            }
        }
    }
}
