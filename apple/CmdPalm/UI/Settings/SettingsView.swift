import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case general, phone, devices, deck, advanced, about

    var id: Self { self }

    var title: String {
        switch self {
        case .general: "General"
        case .phone: "Phone Setup"
        case .devices: "Devices"
        case .deck: "Deck"
        case .advanced: "Advanced"
        case .about: "About"
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape.fill"
        case .phone: "qrcode"
        case .devices: "iphone.gen3"
        case .deck: "square.grid.3x2.fill"
        case .advanced: "wrench.and.screwdriver.fill"
        case .about: "info"
        }
    }

    var color: Color {
        switch self {
        case .general: .gray
        case .phone: .blue
        case .devices: .green
        case .deck: .orange
        case .advanced: .indigo
        case .about: .gray
        }
    }
}

@MainActor
@Observable
final class SettingsNavigation {
    static let shared = SettingsNavigation()
    var selection: SettingsTab? = .general
    private init() {}
}

struct SettingsView: View {
    @State private var navigation = SettingsNavigation.shared

    var body: some View {
        NavigationSplitView(columnVisibility: .constant(.all)) {
            List(SettingsTab.allCases, selection: $navigation.selection) { tab in
                Label {
                    Text(tab.title)
                } icon: {
                    SymbolBadge(symbol: tab.symbol, color: tab.color)
                }
                .tag(tab)
            }
            .listStyle(.sidebar)
            .softScrollEdge()
            .frame(width: 210)
            .navigationSplitViewColumnWidth(210)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            let tab = navigation.selection ?? .general
            Group {
                switch tab {
                case .general: GeneralPane()
                case .phone: PhoneSetupPane()
                case .devices: DevicesPane()
                case .deck: DeckPane()
                case .advanced: AdvancedPane()
                case .about: AboutPane()
                }
            }
            .navigationTitle(tab.title)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 680, minHeight: 480)
    }
}

extension View {
    func settingsForm() -> some View {
        formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 8, for: .scrollContent)
            .softScrollEdge()
    }

    @ViewBuilder
    func softScrollEdge() -> some View {
        if #available(macOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
    }
}

struct DescribedToggle: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool

    init(_ title: String, detail: String, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        _isOn = isOn
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
    }
}

struct PermissionRow: View {
    let title: String
    let detail: String
    let granted: Bool
    let action: String
    let perform: () -> Void

    var body: some View {
        LabeledContent {
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Button(action, action: perform)
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
