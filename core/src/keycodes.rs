//! macOS virtual key codes (ANSI positions) and modifier bookkeeping.
//!
//! Key codes identify physical key *positions*; the active input source decides
//! which character a position produces. Clients send positions and receive the
//! Mac's current layout labels so caps always match what will be typed.

pub type KeyCode = u16;

pub const KEY_A: KeyCode = 0x00;
pub const KEY_RETURN: KeyCode = 0x24;
pub const KEY_TAB: KeyCode = 0x30;
pub const KEY_SPACE: KeyCode = 0x31;
pub const KEY_DELETE: KeyCode = 0x33;
pub const KEY_ESCAPE: KeyCode = 0x35;
pub const KEY_RIGHT_COMMAND: KeyCode = 0x36;
pub const KEY_COMMAND: KeyCode = 0x37;
pub const KEY_SHIFT: KeyCode = 0x38;
pub const KEY_CAPS_LOCK: KeyCode = 0x39;
pub const KEY_OPTION: KeyCode = 0x3A;
pub const KEY_CONTROL: KeyCode = 0x3B;
pub const KEY_RIGHT_SHIFT: KeyCode = 0x3C;
pub const KEY_RIGHT_OPTION: KeyCode = 0x3D;
pub const KEY_RIGHT_CONTROL: KeyCode = 0x3E;
pub const KEY_FUNCTION: KeyCode = 0x3F;
pub const KEY_HOME: KeyCode = 0x73;
pub const KEY_PAGE_UP: KeyCode = 0x74;
pub const KEY_FORWARD_DELETE: KeyCode = 0x75;
pub const KEY_END: KeyCode = 0x77;
pub const KEY_PAGE_DOWN: KeyCode = 0x79;
pub const KEY_LEFT: KeyCode = 0x7B;
pub const KEY_RIGHT: KeyCode = 0x7C;
pub const KEY_DOWN: KeyCode = 0x7D;
pub const KEY_UP: KeyCode = 0x7E;

pub const KEY_C: KeyCode = 0x08;
pub const KEY_V: KeyCode = 0x09;
pub const KEY_Q: KeyCode = 0x0C;
pub const KEY_W: KeyCode = 0x0D;
pub const KEY_F: KeyCode = 0x03;
pub const KEY_H: KeyCode = 0x04;
pub const KEY_M: KeyCode = 0x2E;
pub const KEY_3: KeyCode = 0x14;
pub const KEY_4: KeyCode = 0x15;
pub const KEY_5: KeyCode = 0x17;
pub const KEY_EQUAL: KeyCode = 0x18;
pub const KEY_MINUS: KeyCode = 0x1B;
pub const KEY_LEFT_BRACKET: KeyCode = 0x21;
pub const KEY_RIGHT_BRACKET: KeyCode = 0x1E;

/// Highest code accepted from clients. Apple keyboards report a few special
/// keys above 127 (e.g. 0xA0 Mission Control, 0xB1 Spotlight).
pub const MAX_KEYCODE: KeyCode = 0xFF;

/// Wire modifier bits shared with the web client.
pub mod mods {
    pub const COMMAND: u8 = 1;
    pub const SHIFT: u8 = 2;
    pub const OPTION: u8 = 4;
    pub const CONTROL: u8 = 8;
    pub const FN: u8 = 16;
    pub const ALL: u8 = COMMAND | SHIFT | OPTION | CONTROL | FN;
}

/// CGEventFlags bits (see `CGEventTypes.h` and IOKit `IOLLEvent.h`).
pub mod flags {
    pub const ALPHA_SHIFT: u64 = 0x0001_0000;
    pub const SHIFT: u64 = 0x0002_0000;
    pub const CONTROL: u64 = 0x0004_0000;
    pub const ALTERNATE: u64 = 0x0008_0000;
    pub const COMMAND: u64 = 0x0010_0000;
    pub const NUMERIC_PAD: u64 = 0x0020_0000;
    pub const SECONDARY_FN: u64 = 0x0080_0000;
    /// Set on every hardware-originated event; some apps treat its absence as
    /// a coalesced/synthetic event.
    pub const NON_COALESCED: u64 = 0x0000_0100;

    pub const DEVICE_LEFT_CONTROL: u64 = 0x0000_0001;
    pub const DEVICE_LEFT_SHIFT: u64 = 0x0000_0002;
    pub const DEVICE_RIGHT_SHIFT: u64 = 0x0000_0004;
    pub const DEVICE_LEFT_COMMAND: u64 = 0x0000_0008;
    pub const DEVICE_RIGHT_COMMAND: u64 = 0x0000_0010;
    pub const DEVICE_LEFT_OPTION: u64 = 0x0000_0020;
    pub const DEVICE_RIGHT_OPTION: u64 = 0x0000_0040;
    pub const DEVICE_RIGHT_CONTROL: u64 = 0x0000_2000;
}

/// A modifier key with the event flags it contributes while held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModifierKey {
    pub code: KeyCode,
    pub wire: u8,
    pub flags: u64,
}

pub const MODIFIER_KEYS: [ModifierKey; 9] = [
    ModifierKey { code: KEY_CONTROL, wire: mods::CONTROL, flags: flags::CONTROL | flags::DEVICE_LEFT_CONTROL },
    ModifierKey { code: KEY_RIGHT_CONTROL, wire: mods::CONTROL, flags: flags::CONTROL | flags::DEVICE_RIGHT_CONTROL },
    ModifierKey { code: KEY_OPTION, wire: mods::OPTION, flags: flags::ALTERNATE | flags::DEVICE_LEFT_OPTION },
    ModifierKey { code: KEY_RIGHT_OPTION, wire: mods::OPTION, flags: flags::ALTERNATE | flags::DEVICE_RIGHT_OPTION },
    ModifierKey { code: KEY_SHIFT, wire: mods::SHIFT, flags: flags::SHIFT | flags::DEVICE_LEFT_SHIFT },
    ModifierKey { code: KEY_RIGHT_SHIFT, wire: mods::SHIFT, flags: flags::SHIFT | flags::DEVICE_RIGHT_SHIFT },
    ModifierKey { code: KEY_COMMAND, wire: mods::COMMAND, flags: flags::COMMAND | flags::DEVICE_LEFT_COMMAND },
    ModifierKey { code: KEY_RIGHT_COMMAND, wire: mods::COMMAND, flags: flags::COMMAND | flags::DEVICE_RIGHT_COMMAND },
    ModifierKey { code: KEY_FUNCTION, wire: mods::FN, flags: flags::SECONDARY_FN },
];

/// Order used when a combo has to press modifiers itself. Matches the order a
/// person typically presses them and keeps event sequences deterministic.
pub const COMBO_PRESS_ORDER: [(u8, KeyCode); 5] = [
    (mods::CONTROL, KEY_CONTROL),
    (mods::OPTION, KEY_OPTION),
    (mods::SHIFT, KEY_SHIFT),
    (mods::COMMAND, KEY_COMMAND),
    (mods::FN, KEY_FUNCTION),
];

pub fn modifier(code: KeyCode) -> Option<ModifierKey> {
    MODIFIER_KEYS.iter().copied().find(|m| m.code == code)
}

pub fn is_modifier(code: KeyCode) -> bool {
    modifier(code).is_some()
}

/// Flags hardware adds to particular keys. Real arrow keys carry the Fn and
/// numeric-pad bits; function/navigation keys carry Fn. Some apps and system
/// hotkeys (e.g. Ctrl-Arrow for Spaces) only match when these bits are present.
pub fn intrinsic_flags(code: KeyCode) -> u64 {
    match code {
        KEY_LEFT | KEY_RIGHT | KEY_DOWN | KEY_UP => flags::SECONDARY_FN | flags::NUMERIC_PAD,
        0x7A | 0x78 | 0x63 | 0x76 | 0x60 | 0x61 | 0x62 | 0x64 | 0x65 | 0x6D | 0x67 | 0x6F | 0x69 | 0x6B | 0x71
        | 0x6A | 0x40 | 0x4F | 0x50 | 0x5A | 0x72 | KEY_HOME | KEY_END | KEY_PAGE_UP | KEY_PAGE_DOWN
        | KEY_FORWARD_DELETE => flags::SECONDARY_FN,
        0x41 | 0x43 | 0x45 | 0x47 | 0x4B | 0x4C | 0x4E | 0x51..=0x59 | 0x5B | 0x5C => flags::NUMERIC_PAD,
        _ => 0,
    }
}

/// Map a wire modifier mask to the generic CGEventFlags it implies.
pub fn wire_to_generic_flags(mask: u8) -> u64 {
    let mut out = 0;
    if mask & mods::COMMAND != 0 {
        out |= flags::COMMAND;
    }
    if mask & mods::SHIFT != 0 {
        out |= flags::SHIFT;
    }
    if mask & mods::OPTION != 0 {
        out |= flags::ALTERNATE;
    }
    if mask & mods::CONTROL != 0 {
        out |= flags::CONTROL;
    }
    if mask & mods::FN != 0 {
        out |= flags::SECONDARY_FN;
    }
    out
}

/// Parse an accelerator such as `cmd+shift+4` into (key code, wire modifiers).
/// Only used for built-in actions; user combos arrive pre-resolved.
pub fn named_key(name: &str) -> Option<KeyCode> {
    let code = match name {
        "a" => 0x00,
        "s" => 0x01,
        "d" => 0x02,
        "f" => 0x03,
        "h" => 0x04,
        "g" => 0x05,
        "z" => 0x06,
        "x" => 0x07,
        "c" => 0x08,
        "v" => 0x09,
        "b" => 0x0B,
        "q" => 0x0C,
        "w" => 0x0D,
        "e" => 0x0E,
        "r" => 0x0F,
        "y" => 0x10,
        "t" => 0x11,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "6" => 0x16,
        "5" => 0x17,
        "=" => 0x18,
        "9" => 0x19,
        "7" => 0x1A,
        "-" => 0x1B,
        "8" => 0x1C,
        "0" => 0x1D,
        "]" => 0x1E,
        "o" => 0x1F,
        "u" => 0x20,
        "[" => 0x21,
        "i" => 0x22,
        "p" => 0x23,
        "l" => 0x25,
        "j" => 0x26,
        "'" => 0x27,
        "k" => 0x28,
        ";" => 0x29,
        "\\" => 0x2A,
        "," => 0x2B,
        "/" => 0x2C,
        "n" => 0x2D,
        "m" => 0x2E,
        "." => 0x2F,
        "`" => 0x32,
        "return" => KEY_RETURN,
        "tab" => KEY_TAB,
        "space" => KEY_SPACE,
        "delete" => KEY_DELETE,
        "escape" => KEY_ESCAPE,
        "left" => KEY_LEFT,
        "right" => KEY_RIGHT,
        "up" => KEY_UP,
        "down" => KEY_DOWN,
        "f11" => 0x67,
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_are_recognized_and_carry_device_bits() {
        let left = modifier(KEY_COMMAND).unwrap();
        let right = modifier(KEY_RIGHT_COMMAND).unwrap();
        assert_eq!(left.wire, mods::COMMAND);
        assert_ne!(left.flags, right.flags);
        assert!(left.flags & flags::COMMAND != 0 && right.flags & flags::COMMAND != 0);
        assert!(!is_modifier(KEY_A));
        assert!(!is_modifier(KEY_CAPS_LOCK), "caps lock is a lock key, not a held modifier");
    }

    #[test]
    fn arrows_carry_hardware_flags() {
        assert_eq!(intrinsic_flags(KEY_LEFT), flags::SECONDARY_FN | flags::NUMERIC_PAD);
        assert_eq!(intrinsic_flags(KEY_A), 0);
    }
}
