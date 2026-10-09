import SwiftUI

extension View {
    /// A subtle rounded panel that groups related rows. With Increase
    /// Contrast it gains an outline, as the fill alone is hard to see.
    func cardBackground(cornerRadius: CGFloat = 10, tint: Color? = nil) -> some View {
        modifier(CardBackground(cornerRadius: cornerRadius, tint: tint))
    }

    @ViewBuilder
    func glassButtonStyle() -> some View {
        if #available(macOS 26.0, *) {
            buttonStyle(.glass)
        } else {
            buttonStyle(.bordered)
        }
    }
}

private struct CardBackground: ViewModifier {
    let cornerRadius: CGFloat
    let tint: Color?
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                if let tint {
                    shape.fill(tint.opacity(contrast == .increased ? 0.18 : 0.12))
                } else {
                    shape.fill(.fill.quaternary)
                }
            }
            .overlay {
                if contrast == .increased {
                    shape.strokeBorder(tint.map { AnyShapeStyle($0.opacity(0.6)) } ?? AnyShapeStyle(.separator))
                }
            }
    }
}

struct HoverBackground: View {
    let active: Bool
    var pressed = false
    var cornerRadius: CGFloat = 6

    var body: some View {
        if active || pressed {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(pressed ? AnyShapeStyle(.fill.secondary) : AnyShapeStyle(.fill.tertiary))
        }
    }
}

struct MenuRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .background(HoverBackground(active: hovering, pressed: configuration.isPressed))
                .onHover { hovering = $0 }
        }
    }
}

struct MenuRowLabel: View {
    let title: String
    let symbol: String
    var shortcut: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(title)
            Spacer(minLength: 8)
            if let shortcut {
                Text(shortcut)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
    }
}

struct MenuSectionHeader<Accessory: View>: View {
    let title: String
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            accessory()
        }
        .padding(.horizontal, 4)
    }
}

extension MenuSectionHeader where Accessory == EmptyView {
    init(_ title: String) {
        self.title = title
        accessory = { EmptyView() }
    }
}

extension MenuSectionHeader {
    init(_ title: String, @ViewBuilder accessory: @escaping () -> Accessory) {
        self.title = title
        self.accessory = accessory
    }
}

struct StatusDot: View {
    let color: Color
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color.gradient)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct SymbolBadge: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.55, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
            .accessibilityHidden(true)
    }
}
