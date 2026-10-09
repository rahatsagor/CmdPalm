import Carbon
import Foundation

/// Reads what each key types on the Mac's active keyboard layout, so the
/// phone shows the right labels and shortcuts follow the labelled key.
@MainActor
enum KeyboardLayouts {
    /// Character-producing key positions (ANSI, ISO and JIS extras).
    private static let codes: [UInt16] = Array(0x00...0x32).filter { ![0x24, 0x30, 0x31].contains($0) } + [0x5D, 0x5E, 0x5F]

    private static let levels: [(bit: UInt8, modifiers: UInt32)] = [
        (1 << 0, 0),
        (1 << 1, UInt32(shiftKey)),
        (1 << 2, UInt32(optionKey)),
        (1 << 3, UInt32(shiftKey | optionKey)),
    ]

    static func current() -> KeyboardLayout? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        let id = string(source, kTISPropertyInputSourceID) ?? "unknown"
        let name = string(source, kTISPropertyLocalizedName) ?? id
        let keyboardType = UInt32(LMGetKbdType())
        let iso = KBGetLayoutType(Int16(keyboardType)) == kKeyboardISO

        let keys: [KeyCap] = data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return [] }
            let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
            return codes.compactMap { code in
                var labels = ["", "", "", ""]
                var dead: UInt8 = 0
                for (index, level) in levels.enumerated() {
                    let (text, isDead) = translate(layout, code: code, modifiers: level.modifiers, keyboardType: keyboardType)
                    labels[index] = text
                    if isDead { dead |= level.bit }
                }
                guard !labels[0].isEmpty || !labels[1].isEmpty else { return nil }
                return KeyCap(code: code, base: labels[0], shift: labels[1], option: labels[2], optionShift: labels[3], dead: dead)
            }
        }
        return KeyboardLayout(id: id, name: name, iso: iso, keys: keys)
    }

    /// The text a key produces, and whether it is a dead key (an accent that
    /// combines with the next key). Dead keys report their spacing accent.
    private static func translate(
        _ layout: UnsafePointer<UCKeyboardLayout>, code: UInt16, modifiers: UInt32, keyboardType: UInt32
    ) -> (String, Bool) {
        var deadState: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        let modifierState = (modifiers >> 8) & 0xFF
        var status = UCKeyTranslate(
            layout, code, UInt16(kUCKeyActionDown), modifierState, keyboardType, 0,
            &deadState, chars.count, &length, &chars
        )
        guard status == noErr else { return ("", false) }
        let isDead = deadState != 0
        if isDead {
            // A space after a dead key yields the accent on its own.
            status = UCKeyTranslate(
                layout, 0x31, UInt16(kUCKeyActionDown), 0, keyboardType, 0,
                &deadState, chars.count, &length, &chars
            )
            guard status == noErr else { return ("", true) }
        }
        let text = String(utf16CodeUnits: chars, count: length)
        if text.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) { return ("", false) }
        return (text, isDead)
    }

    private static func string(_ source: TISInputSource, _ key: CFString) -> String? {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }

    /// Calls `handler` on the main actor whenever the input source changes.
    static func observe(_ handler: @escaping @MainActor () -> Void) -> NSObjectProtocol {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { handler() }
        }
    }
}
