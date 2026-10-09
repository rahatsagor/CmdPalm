import SwiftUI

struct WelcomeView: View {
    @Environment(HostController.self) private var host
    @Environment(Permissions.self) private var permissions
    @State private var step = Step.intro
    @State private var pairedAtStart: String?

    enum Step: Int, CaseIterable {
        case intro, permission, connect
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch step {
                case .intro: intro
                case .permission: permission
                case .connect: connect
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 40)
            .padding(.top, 36)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
            .id(step)

            footer
                .padding(20)
        }
        .frame(width: 560, height: 600)
        .animation(.snappy(duration: 0.25), value: step)
        .onAppear { pairedAtStart = host.lastPaired }
    }

    private var intro: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
            Text("Welcome to CmdPalm")
                .font(.largeTitle.bold())
            Text("Use your phone or iPad as a trackpad, keyboard and button deck for this Mac. Nothing to install on the phone, and nothing leaves your network.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 12) {
                Feature(symbol: "hand.point.up.left", title: "Trackpad", detail: "Click, drag, scroll and pinch with familiar gestures.")
                Feature(symbol: "keyboard", title: "Keyboard", detail: "Type, dictate and press any shortcut, with modifiers that stick.")
                Feature(symbol: "square.grid.3x2", title: "Deck", detail: "Buttons for apps, shortcuts, media and text snippets.")
            }
            .padding(.top, 6)
        }
    }

    private var permission: some View {
        VStack(spacing: 18) {
            Image(systemName: permissions.canControl ? "checkmark.shield.fill" : "hand.raised.fill")
                .font(.system(size: 56))
                .foregroundStyle(permissions.canControl ? .green : .orange)
                .contentTransition(.symbolEffect(.replace))
            Text(permissions.canControl ? "CmdPalm can control this Mac" : "Allow CmdPalm to control this Mac")
                .font(.title.bold())
                .multilineTextAlignment(.center)
            Text("macOS asks before any app moves the pointer or types. CmdPalm only does this for devices you pair.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if !permissions.canControl {
                VStack(alignment: .leading, spacing: 8) {
                    Text("1. Click Open System Settings.")
                    Text("2. Turn on CmdPalm under Accessibility. You may need to enter your password.")
                    Text("3. Come back here. This page updates by itself.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Button("Open System Settings") { permissions.requestControl() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
        }
    }

    private var connect: some View {
        VStack(spacing: 14) {
            if let name = host.lastPaired, name != pairedAtStart {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
                Text("\(name) is connected")
                    .font(.title.bold())
                    .multilineTextAlignment(.center)
                Text("Tip: add CmdPalm to the phone’s home screen (Share → Add to Home Screen on iPhone, or the browser menu on Android) to open it like an app. CmdPalm lives in the menu bar; click its icon to pair more devices.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Connect your phone")
                    .font(.title.bold())
                Text("Join the same Wi-Fi as this Mac, then scan the code with the phone’s camera.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                PairingCard(qrSize: 168)
                    .frame(width: 300)
            }
        }
    }

    private var footer: some View {
        HStack {
            HStack(spacing: 6) {
                ForEach(Step.allCases, id: \.self) { item in
                    Circle()
                        .fill(item == step ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 7, height: 7)
                }
            }
            .accessibilityHidden(true)
            Spacer()
            if step != .intro {
                Button("Back") { step = Step(rawValue: step.rawValue - 1) ?? .intro }
            }
            Button(primaryTitle, action: advance)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
        }
        .controlSize(.large)
    }

    private var primaryTitle: String {
        switch step {
        case .intro: "Get Started"
        case .permission: permissions.canControl ? "Continue" : "Later"
        case .connect: host.lastPaired != pairedAtStart && host.lastPaired != nil ? "Done" : "Finish"
        }
    }

    private func advance() {
        if let next = Step(rawValue: step.rawValue + 1) {
            step = next
        } else {
            WelcomeWindowController.close()
        }
    }
}

private struct Feature: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).foregroundStyle(.secondary)
            }
        }
    }
}
