import AppKit
import SwiftUI

/// Extra folders for the phone's app list, such as apps kept on an external drive.
struct AppFoldersSection: View {
    @Environment(Preferences.self) private var preferences
    /// Path → app count, or nil while the folder is unavailable.
    @State private var counts: [String: Int?] = [:]

    var body: some View {
        Section {
            ForEach(preferences.appFolders, id: \.self) { path in
                FolderRow(path: path, count: counts[path] ?? .some(-1)) {
                    preferences.removeAppFolder(path)
                }
            }
            LabeledContent {
                Button("Add Folder…", action: choose)
                    .disabled(preferences.appFolders.count >= Preferences.maxAppFolders)
            } label: {
                Text("Your phone lists apps in Applications. Add other folders, such as one on an external drive, to list those apps too.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("App Folders")
        }
        .task(id: preferences.appFolders) { await count() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didMountNotification)) { _ in
            Task { await count() }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didUnmountNotification)) { _ in
            Task { await count() }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        panel.message = "Choose folders that contain apps."
        panel.directoryURL = URL(fileURLWithPath: "/Volumes", isDirectory: true)
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { preferences.addAppFolder(url) }
    }

    private func count() async {
        let paths = preferences.appFolders
        let result = await Task.detached(priority: .utility) {
            Dictionary(uniqueKeysWithValues: paths.map { path in
                (path, AppCatalog.apps(in: URL(fileURLWithPath: path, isDirectory: true)).map(\.count))
            })
        }.value
        counts = result
    }
}

private struct FolderRow: View {
    let path: String
    /// -1 while counting, nil when the folder cannot be found.
    let count: Int?
    let remove: () -> Void

    var body: some View {
        LabeledContent {
            Button(role: .destructive, action: remove) {
                Image(systemName: "minus.circle.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help("Remove this folder")
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(FileManager.default.displayName(atPath: path))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(count == nil ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            } icon: {
                Image(nsImage: NSWorkspace.shared.icon(forFile: path))
                    .resizable()
                    .frame(width: 20, height: 20)
            }
        }
        .contextMenu {
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                .disabled(count == nil)
        }
    }

    private var detail: String {
        let shown = (path as NSString).abbreviatingWithTildeInPath
        switch count {
        case nil: return "Not available. Connect the drive to list its apps. · \(shown)"
        case -1: return shown
        case 1: return "1 app · \(shown)"
        case let n?: return "\(n) apps · \(shown)"
        }
    }
}
