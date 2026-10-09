import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// A QR code drawn with crisp square modules on a white quiet zone, which
/// phone cameras read reliably in dark mode too.
struct QRCodeView: View {
    let text: String
    var size: CGFloat = 180

    var body: some View {
        Group {
            if let image = Self.image(for: text) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(1, contentMode: .fit)
            } else {
                Image(systemName: "qrcode")
                    .font(.system(size: size / 3))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(size * 0.07)
        .frame(width: size, height: size)
        .background(.white, in: RoundedRectangle(cornerRadius: size * 0.09, style: .continuous))
        .overlay {
            // Keeps the white plate's edge visible on light backgrounds.
            RoundedRectangle(cornerRadius: size * 0.09, style: .continuous)
                .strokeBorder(.black.opacity(0.08))
        }
        .accessibilityLabel("QR code for \(text)")
    }

    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    static func image(for text: String) -> CGImage? {
        guard !text.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        // Pre-scaled with nearest-neighbour sampling: some render paths ignore `.interpolation(.none)`.
        guard let output = filter.outputImage?.samplingNearest().transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        else { return nil }
        return context.createCGImage(output, from: output.extent)
    }
}
