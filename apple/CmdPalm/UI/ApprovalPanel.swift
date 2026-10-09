import AppKit
import SwiftUI

/// A floating prompt for devices asking to connect without a QR code or PIN.
/// It does not take focus, so whatever the person is typing is not interrupted.
@MainActor
enum ApprovalPanel {
    private static var panel: NSPanel?

    static func update() {
        let host = AppModel.shared.host
        guard !host.approvals.isEmpty else {
            panel?.orderOut(nil)
            panel = nil
            return
        }
        if panel == nil {
            let panel = makePanel()
            self.panel = panel
            position(panel)
            panel.orderFrontRegardless()
            NSSound(named: "Glass")?.play()
        }
    }

    private static func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 140),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        let view = NSHostingView(rootView: ApprovalPrompt().appEnvironment())
        view.sizingOptions = [.preferredContentSize]
        panel.contentView = view
        return panel
    }

    private static func position(_ panel: NSPanel) {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let size = panel.frame.size
        let visible = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: visible.maxX - size.width - 16, y: visible.maxY - size.height - 12))
    }
}

private struct ApprovalPrompt: View {
    @Environment(HostController.self) private var host

    var body: some View {
        if let request = host.approvals.first {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Allow “\(request.deviceName)” to control this Mac?")
                            .font(.headline)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(detail(request))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack {
                    if host.approvals.count > 1 {
                        Text("\(host.approvals.count - 1) more waiting")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Don’t Allow") { host.respond(to: request, allow: false) }
                        .keyboardShortcut(.cancelAction)
                    Button("Allow") { host.respond(to: request, allow: true) }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 340)
        }
    }

    private func detail(_ request: ApprovalRequest) -> String {
        let model = request.model.isEmpty ? "A device" : request.model
        return "\(model) at \(request.address) wants to connect. Only allow devices you recognize."
    }
}
