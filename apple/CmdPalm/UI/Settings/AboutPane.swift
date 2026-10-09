import AppKit
import SwiftUI

struct AboutPane: View {
    static let website = URL(string: "https://cmdpalm.app")!
    static let repository = URL(string: "https://github.com/rahatsagor/CmdPalm")!

    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 112, height: 112)
                    .accessibilityHidden(true)
                Text("CmdPalm")
                    .font(.largeTitle.weight(.bold))
                    .padding(.top, 8)
                Text(versionText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.top, 2)
                    .contextMenu {
                        Button("Copy Version") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString("CmdPalm \(versionText)", forType: .string)
                        }
                    }
                Text("Your phone as a trackpad, keyboard and button deck for your Mac.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)

                links
                    .padding(.top, 24)

                privacy
                    .frame(maxWidth: 440)
                    .padding(.top, 32)

                Text("© 2026 CmdPalm. Free and open source under the GNU AGPL v3.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 24)
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity)
        }
        .softScrollEdge()
    }

    private var versionText: String {
        "Version \(SystemInfo.appVersion) (\(SystemInfo.buildNumber)) · Core \(coreVersion())"
    }

    private var links: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                linkButton("Website", symbol: "globe", url: Self.website)
                linkButton("Release Notes", symbol: "sparkles", url: Self.repository.appending(path: "releases"))
                linkButton("Source Code", symbol: "chevron.left.forwardslash.chevron.right", url: Self.repository)
                linkButton("Report a Problem", symbol: "exclamationmark.bubble", url: Self.repository.appending(path: "issues/new/choose"))
            }
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    linkButton("Website", symbol: "globe", url: Self.website)
                    linkButton("Release Notes", symbol: "sparkles", url: Self.repository.appending(path: "releases"))
                }
                HStack(spacing: 8) {
                    linkButton("Source Code", symbol: "chevron.left.forwardslash.chevron.right", url: Self.repository)
                    linkButton("Report a Problem", symbol: "exclamationmark.bubble", url: Self.repository.appending(path: "issues/new/choose"))
                }
            }
        }
        .controlSize(.large)
    }

    private func linkButton(_ title: String, symbol: String, url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            Label(title, systemImage: symbol)
                .fixedSize()
        }
        .glassButtonStyle()
        .help(url.absoluteString)
    }

    private var privacy: some View {
        HStack(alignment: .top, spacing: 12) {
            SymbolBadge(symbol: "lock.fill", color: .blue, size: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text("Private by design")
                    .font(.headline)
                Text("CmdPalm works entirely on your local network. There are no accounts, analytics or cloud services. Only update checks go online, to GitHub.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .cardBackground(cornerRadius: 12)
    }
}
