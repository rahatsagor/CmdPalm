import SwiftUI
import UniformTypeIdentifiers

struct DeckPane: View {
    @Environment(HostController.self) private var host
    @Environment(Preferences.self) private var preferences
    @State private var summary = ""
    @State private var deckHash: Int?
    @State private var error: String?
    @State private var confirmReset = false
    @State private var confirmShell = false

    var body: some View {
        Form {
            Section {
                Text("The deck is a grid of buttons on your phone that open apps, press shortcuts, type text and more. To change it, tap Edit on the phone’s Deck tab. Every paired device shares the same deck.")
                    .fixedSize(horizontal: false, vertical: true)
                LabeledContent("Current deck", value: summary)
            }

            Section("Backup") {
                LabeledContent {
                    HStack {
                        Button("Import…", action: importDeck)
                        Button("Export…", action: exportDeck)
                    }
                } label: {
                    Text("Deck file")
                    Text("Export a copy, or import one. Importing replaces the deck on every device.")
                }
                LabeledContent {
                    Button("Reset…", role: .destructive) { confirmReset = true }
                } label: {
                    Text("Start over with the default deck")
                    Text("Replaces every page and button.")
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section("Shell Commands") {
                DescribedToggle(
                    "Allow buttons to run shell commands",
                    detail: "Buttons can run any command as your user account. Only turn this on if you trust every paired device.",
                    isOn: Binding(
                        get: { preferences.allowShell },
                        set: { newValue in
                            if newValue { confirmShell = true } else { preferences.allowShell = false }
                        }
                    )
                )
            }
        }
        .settingsForm()
        .task {
            // Phones edit the deck too, and the core sends no event for that.
            while !Task.isCancelled {
                refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .confirmationDialog("Reset the deck?", isPresented: $confirmReset) {
            Button("Reset Deck", role: .destructive) {
                host.resetDeck()
                refresh()
            }
        } message: {
            Text("Every page and button is replaced with the defaults on all devices. Export first to keep a copy.")
        }
        .confirmationDialog("Allow shell commands?", isPresented: $confirmShell) {
            Button("Allow Shell Commands", role: .destructive) { preferences.allowShell = true }
        } message: {
            Text("Deck buttons will be able to run commands with full access to your files. Paired devices can create such buttons.")
        }
    }

    private func refresh() {
        let json = host.deckJSON()
        guard json.hashValue != deckHash else { return }
        deckHash = json.hashValue
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let pages = object["pages"] as? [[String: Any]]
        else {
            summary = ""
            return
        }
        let tiles = pages.reduce(0) { $0 + (($1["tiles"] as? [Any])?.count ?? 0) }
        let pageText = pages.count == 1 ? "1 page" : "\(pages.count) pages"
        let tileText = tiles == 1 ? "1 button" : "\(tiles) buttons"
        summary = "\(pageText), \(tileText)"
    }

    private func exportDeck() {
        error = nil
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "CmdPalm Deck.json"
        panel.allowedContentTypes = [.json]
        let json = host.deckJSON()
        AppActivation.shared.present {
            guard panel.runModal() == .OK, let url = panel.url else { return }
            do {
                try Data(json.utf8).write(to: url, options: .atomic)
            } catch {
                self.error = "Couldn’t save the deck: \(error.localizedDescription)"
            }
        }
    }

    private func importDeck() {
        error = nil
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        AppActivation.shared.present {
            guard panel.runModal() == .OK, let url = panel.url else { return }
            do {
                let data = try Data(contentsOf: url)
                guard data.count < 2_000_000, let json = String(data: data, encoding: .utf8) else {
                    self.error = "That file isn’t a CmdPalm deck."
                    return
                }
                try host.importDeck(json)
                refresh()
            } catch let failure as HostError {
                if case let .Failed(message) = failure { self.error = "Couldn’t import the deck: \(message)" }
            } catch {
                self.error = "Couldn’t read the file: \(error.localizedDescription)"
            }
        }
    }
}
