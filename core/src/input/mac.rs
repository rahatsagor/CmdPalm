//! CGEvent-backed [`EventSink`].

use std::ffi::{c_char, c_void};
use std::time::{Duration, Instant};

use objc2_core_foundation::{CFRetained, CGPoint, CGRect};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID,
    CGEventTapLocation, CGEventType, CGGetActiveDisplayList, CGMouseButton, CGScrollEventUnit,
};

use super::{EventSink, Synth};
use crate::keycodes::{self, flags};
use crate::protocol::{MediaKey, MouseButton};

/// Written to `kCGEventSourceUserData` on every event CmdPalm posts so they
/// can be told apart from hardware events ("CMDP").
pub const EVENT_MARKER: i64 = 0x434D_4450;

const CACHE_TTL: Duration = Duration::from_millis(750);
const DISPLAY_TTL: Duration = Duration::from_secs(2);
const MAX_DISPLAYS: usize = 32;

type MachPort = u32;
type IoObject = u32;
type IoConnect = u32;
type KernReturn = i32;

const KERN_SUCCESS: KernReturn = 0;
const IO_HID_PARAM_CONNECT_TYPE: u32 = 1;
const IO_HID_CAPS_LOCK_STATE: i32 = 1;
const NX_SYSDEFINED: u32 = 14;
const NX_SUBTYPE_AUX_CONTROL_BUTTONS: i16 = 8;
const NX_EVENT_DATA_VERSION: u32 = 2;
const NX_KEYSTATE_DOWN: i32 = 0x0A;
const NX_KEYSTATE_UP: i32 = 0x0B;
const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;

#[repr(C)]
#[derive(Clone, Copy)]
struct IoGPoint {
    x: i16,
    y: i16,
}

/// `NXEventData.compound`, padded well past the size of the full union so
/// IOKit never reads beyond our buffer.
#[repr(C)]
struct NxCompoundEvent {
    reserved: i16,
    sub_type: i16,
    misc: [i32; 11],
    padding: [u8; 80],
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    static mach_task_self_: MachPort;
    fn IOServiceMatching(name: *const c_char) -> *mut c_void;
    fn IOServiceGetMatchingService(main_port: MachPort, matching: *mut c_void) -> IoObject;
    fn IOServiceOpen(service: IoObject, owning_task: MachPort, kind: u32, connect: *mut IoConnect) -> KernReturn;
    fn IOServiceClose(connect: IoConnect) -> KernReturn;
    fn IOObjectRelease(object: IoObject) -> KernReturn;
    fn IOHIDPostEvent(
        connect: IoConnect,
        event_type: u32,
        location: IoGPoint,
        event_data: *const NxCompoundEvent,
        event_data_version: u32,
        event_flags: u32,
        options: u32,
    ) -> KernReturn;
    fn IOHIDGetModifierLockState(connect: IoConnect, selector: i32, state: *mut bool) -> KernReturn;
    fn IOHIDSetModifierLockState(connect: IoConnect, selector: i32, state: bool) -> KernReturn;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

unsafe extern "C" {
    fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
}

/// Run input posting at user-interactive QoS so it is never throttled behind
/// background work (App Nap, low-power scheduling).
pub fn raise_thread_qos() {
    unsafe {
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

/// Whether CmdPalm is allowed to post input. `CGPreflightPostEventAccess`
/// caches its answer for the life of the process, so a grant made while the
/// app runs would go unnoticed until relaunch; the Accessibility check is live.
pub fn has_post_permission() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Lazily opened connection to the HID system for media keys and Caps Lock.
struct HidSystem {
    connect: IoConnect,
}

impl HidSystem {
    fn open() -> Option<Self> {
        unsafe {
            let matching = IOServiceMatching(c"IOHIDSystem".as_ptr());
            if matching.is_null() {
                return None;
            }
            let service = IOServiceGetMatchingService(0, matching);
            if service == 0 {
                return None;
            }
            let mut connect = 0;
            let result = IOServiceOpen(service, mach_task_self_, IO_HID_PARAM_CONNECT_TYPE, &mut connect);
            IOObjectRelease(service);
            (result == KERN_SUCCESS && connect != 0).then_some(Self { connect })
        }
    }
}

impl Drop for HidSystem {
    fn drop(&mut self) {
        unsafe {
            IOServiceClose(self.connect);
        }
    }
}

struct Cached<T> {
    value: T,
    at: Option<Instant>,
}

impl<T: Copy> Cached<T> {
    fn new(value: T) -> Self {
        Self { value, at: None }
    }

    fn get(&mut self, ttl: Duration, refresh: impl FnOnce() -> T) -> T {
        let now = Instant::now();
        if self.at.is_none_or(|at| now.duration_since(at) > ttl) {
            self.value = refresh();
            self.at = Some(now);
        }
        self.value
    }

    fn invalidate(&mut self) {
        self.at = None;
    }
}

pub struct MacSink {
    source: Option<CFRetained<CGEventSource>>,
    hid: Option<HidSystem>,
    /// Sub-point cursor position we last placed the pointer at.
    position: Option<CGPoint>,
    delta_remainder: (f64, f64),
    scroll_remainder: (f64, f64),
    displays: Vec<CGRect>,
    displays_at: Option<Instant>,
    caps: Cached<bool>,
    permission: Cached<bool>,
    secure: Cached<bool>,
}

impl Default for MacSink {
    fn default() -> Self {
        Self::new()
    }
}

impl MacSink {
    pub fn new() -> Self {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
        if let Some(source) = source.as_deref() {
            CGEventSource::set_user_data(Some(source), EVENT_MARKER);
            // Don't suppress the person's real mouse/keyboard after our events.
            CGEventSource::set_local_events_suppression_interval(Some(source), 0.0);
        }
        Self {
            source,
            hid: None,
            position: None,
            delta_remainder: (0.0, 0.0),
            scroll_remainder: (0.0, 0.0),
            displays: Vec::new(),
            displays_at: None,
            caps: Cached::new(false),
            permission: Cached::new(true),
            secure: Cached::new(false),
        }
    }

    fn source(&self) -> Option<&CGEventSource> {
        self.source.as_deref()
    }

    fn hid(&mut self) -> Option<&HidSystem> {
        if self.hid.is_none() {
            self.hid = HidSystem::open();
        }
        self.hid.as_ref()
    }

    fn caps_flag(&mut self) -> u64 {
        let on = self.caps.get(CACHE_TTL, || {
            CGEventSource::flags_state(CGEventSourceStateID::HIDSystemState).contains(CGEventFlags::MaskAlphaShift)
        });
        if on { flags::ALPHA_SHIFT } else { 0 }
    }

    fn post(event: &CGEvent) {
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
    }

    fn os_cursor(&self) -> CGPoint {
        CGEvent::new(self.source()).map(|e| CGEvent::location(Some(&e))).unwrap_or(CGPoint { x: 0.0, y: 0.0 })
    }

    /// Cursor position that preserves sub-point motion, unless the person
    /// moved the pointer with a real mouse in the meantime.
    fn current_position(&mut self) -> CGPoint {
        let os = self.os_cursor();
        match self.position {
            Some(p) if (p.x - os.x).abs() < 1.5 && (p.y - os.y).abs() < 1.5 => p,
            _ => os,
        }
    }

    fn refresh_displays(&mut self) {
        let fresh = self.displays_at.is_some_and(|at| at.elapsed() < DISPLAY_TTL);
        if fresh && !self.displays.is_empty() {
            return;
        }
        let mut ids: [CGDirectDisplayID; MAX_DISPLAYS] = [0; MAX_DISPLAYS];
        let mut count = 0_u32;
        let error = unsafe { CGGetActiveDisplayList(MAX_DISPLAYS as u32, ids.as_mut_ptr(), &mut count) };
        if error.0 == 0 {
            // A display removed mid-query reports an empty rect, which would
            // make the edge clamp panic.
            self.displays = ids[..count as usize]
                .iter()
                .map(|id| CGDisplayBounds(*id))
                .filter(|r| r.size.width >= 1.0 && r.size.height >= 1.0)
                .collect();
        }
        self.displays_at = Some(Instant::now());
    }

    /// Keep the pointer on a display. Points in gaps between displays snap to
    /// the closest display edge instead of escaping.
    fn clamp_to_displays(&mut self, point: CGPoint) -> CGPoint {
        self.refresh_displays();
        let inside = |r: &CGRect| {
            point.x >= r.origin.x
                && point.y >= r.origin.y
                && point.x < r.origin.x + r.size.width
                && point.y < r.origin.y + r.size.height
        };
        if self.displays.is_empty() || self.displays.iter().any(inside) {
            return point;
        }
        self.displays
            .iter()
            .map(|r| CGPoint {
                x: point.x.clamp(r.origin.x, r.origin.x + r.size.width - 1.0),
                y: point.y.clamp(r.origin.y, r.origin.y + r.size.height - 1.0),
            })
            .min_by(|a, b| {
                let da = (a.x - point.x).hypot(a.y - point.y);
                let db = (b.x - point.x).hypot(b.y - point.y);
                da.total_cmp(&db)
            })
            .unwrap_or(point)
    }

    fn mouse_move(&mut self, dx: f64, dy: f64, event_flags: u64, drag: Option<MouseButton>) {
        let start = self.current_position();
        let target = self.clamp_to_displays(CGPoint { x: start.x + dx, y: start.y + dy });
        let (event_type, button) = match drag {
            None => (CGEventType::MouseMoved, CGMouseButton(0)),
            Some(MouseButton::Left) => (CGEventType::LeftMouseDragged, CGMouseButton(0)),
            Some(MouseButton::Right) => (CGEventType::RightMouseDragged, CGMouseButton(1)),
            Some(other) => (CGEventType::OtherMouseDragged, CGMouseButton(button_number(other))),
        };
        let Some(event) = CGEvent::new_mouse_event(self.source(), event_type, target, button) else {
            return;
        };
        // Raw deltas matter to games, 3D tools and pointer-locked web pages.
        let rx = self.delta_remainder.0 + (target.x - start.x);
        let ry = self.delta_remainder.1 + (target.y - start.y);
        let (ix, iy) = (rx.trunc(), ry.trunc());
        self.delta_remainder = (rx - ix, ry - iy);
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventDeltaX, ix as i64);
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventDeltaY, iy as i64);
        if let Some(other) = drag {
            CGEvent::set_integer_value_field(
                Some(&event),
                CGEventField::MouseEventButtonNumber,
                i64::from(button_number(other)),
            );
        }
        let caps = self.caps_flag();
        CGEvent::set_flags(Some(&event), CGEventFlags(event_flags | caps));
        Self::post(&event);
        self.position = Some(target);
    }

    fn mouse_button(&mut self, button: MouseButton, down: bool, clicks: i64, event_flags: u64) {
        let position = self.current_position();
        let (event_type, cg_button) = match (button, down) {
            (MouseButton::Left, true) => (CGEventType::LeftMouseDown, CGMouseButton(0)),
            (MouseButton::Left, false) => (CGEventType::LeftMouseUp, CGMouseButton(0)),
            (MouseButton::Right, true) => (CGEventType::RightMouseDown, CGMouseButton(1)),
            (MouseButton::Right, false) => (CGEventType::RightMouseUp, CGMouseButton(1)),
            (other, true) => (CGEventType::OtherMouseDown, CGMouseButton(button_number(other))),
            (other, false) => (CGEventType::OtherMouseUp, CGMouseButton(button_number(other))),
        };
        let Some(event) = CGEvent::new_mouse_event(self.source(), event_type, position, cg_button) else {
            return;
        };
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventClickState, clicks.max(1));
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventButtonNumber,
            i64::from(button_number(button)),
        );
        let caps = self.caps_flag();
        CGEvent::set_flags(Some(&event), CGEventFlags(event_flags | caps));
        Self::post(&event);
    }

    fn scroll(&mut self, dx: f64, dy: f64, phase: u8, momentum: u8, event_flags: u64) {
        let rx = self.scroll_remainder.0 + dx;
        let ry = self.scroll_remainder.1 + dy;
        let (ix, iy) = (rx.trunc(), ry.trunc());
        self.scroll_remainder = (rx - ix, ry - iy);
        if phase != 0 && phase != super::scroll_phase::CHANGED || momentum == super::momentum_phase::END {
            self.scroll_remainder = (0.0, 0.0);
        }
        let Some(event) =
            CGEvent::new_scroll_wheel_event2(self.source(), CGScrollEventUnit::Pixel, 2, iy as i32, ix as i32, 0)
        else {
            return;
        };
        let e = Some(&*event);
        CGEvent::set_integer_value_field(e, CGEventField::ScrollWheelEventIsContinuous, 1);
        CGEvent::set_integer_value_field(e, CGEventField::ScrollWheelEventScrollPhase, i64::from(phase));
        CGEvent::set_integer_value_field(e, CGEventField::ScrollWheelEventMomentumPhase, i64::from(momentum));
        CGEvent::set_integer_value_field(e, CGEventField::ScrollWheelEventPointDeltaAxis1, iy as i64);
        CGEvent::set_integer_value_field(e, CGEventField::ScrollWheelEventPointDeltaAxis2, ix as i64);
        CGEvent::set_double_value_field(e, CGEventField::ScrollWheelEventFixedPtDeltaAxis1, dy);
        CGEvent::set_double_value_field(e, CGEventField::ScrollWheelEventFixedPtDeltaAxis2, dx);
        let caps = self.caps_flag();
        CGEvent::set_flags(e, CGEventFlags(event_flags | caps));
        CGEvent::set_location(e, self.current_position());
        Self::post(&event);
    }

    fn key(&mut self, code: u16, down: bool, event_flags: u64, repeat: bool, is_flags_change: bool) {
        let Some(event) = CGEvent::new_keyboard_event(self.source(), code, down) else {
            return;
        };
        if is_flags_change {
            CGEvent::set_type(Some(&event), CGEventType::FlagsChanged);
        }
        if repeat {
            CGEvent::set_integer_value_field(Some(&event), CGEventField::KeyboardEventAutorepeat, 1);
        }
        let caps = self.caps_flag();
        CGEvent::set_flags(Some(&event), CGEventFlags(event_flags | caps | flags::NON_COALESCED));
        Self::post(&event);
    }

    fn text(&mut self, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        if units.is_empty() {
            return;
        }
        for down in [true, false] {
            let Some(event) = CGEvent::new_keyboard_event(self.source(), 0, down) else {
                return;
            };
            if down {
                unsafe {
                    CGEvent::keyboard_set_unicode_string(Some(&event), units.len() as _, units.as_ptr());
                }
            }
            // Text must never pick up held modifiers, or "c" could become ⌘C.
            CGEvent::set_flags(Some(&event), CGEventFlags(flags::NON_COALESCED));
            Self::post(&event);
        }
    }

    fn media(&mut self, key: MediaKey, down: bool) {
        let state = if down { NX_KEYSTATE_DOWN } else { NX_KEYSTATE_UP };
        let data1 = (key.nx_keytype() << 16) | (state << 8);
        if let Some(hid) = self.hid() {
            let mut event = NxCompoundEvent {
                reserved: 0,
                sub_type: NX_SUBTYPE_AUX_CONTROL_BUTTONS,
                misc: [0; 11],
                padding: [0; 80],
            };
            event.misc[0] = data1;
            let result = unsafe {
                IOHIDPostEvent(hid.connect, NX_SYSDEFINED, IoGPoint { x: 0, y: 0 }, &event, NX_EVENT_DATA_VERSION, 0, 0)
            };
            if result == KERN_SUCCESS {
                return;
            }
            self.hid = None;
        }
        if let Some(event) = CGEvent::new(self.source()) {
            CGEvent::set_type(Some(&event), CGEventType(NX_SYSDEFINED));
            CGEvent::set_flags(Some(&event), CGEventFlags((state as u64) << 8));
            CGEvent::set_integer_value_field(
                Some(&event),
                CGEventField::MouseEventSubtype,
                i64::from(NX_SUBTYPE_AUX_CONTROL_BUTTONS),
            );
            CGEvent::set_integer_value_field(Some(&event), CGEventField::KeyboardEventKeycode, i64::from(data1));
            Self::post(&event);
        }
    }

    fn toggle_caps_lock(&mut self) {
        let Some(hid) = self.hid() else {
            return;
        };
        let connect = hid.connect;
        let mut state = false;
        unsafe {
            if IOHIDGetModifierLockState(connect, IO_HID_CAPS_LOCK_STATE, &mut state) == KERN_SUCCESS {
                IOHIDSetModifierLockState(connect, IO_HID_CAPS_LOCK_STATE, !state);
            }
        }
        self.caps.invalidate();
    }
}

fn button_number(button: MouseButton) -> u32 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
    }
}

impl EventSink for MacSink {
    fn post(&mut self, event: Synth) {
        match event {
            Synth::Flags { code, flags } => self.key(code, keycodes_is_down(code, flags), flags, false, true),
            Synth::Key { code, down, flags, repeat } => self.key(code, down, flags, repeat, false),
            Synth::Text { text } => self.text(&text),
            Synth::Move { dx, dy, flags, drag } => self.mouse_move(dx, dy, flags, drag),
            Synth::Button { button, down, clicks, flags } => self.mouse_button(button, down, clicks, flags),
            Synth::Scroll { dx, dy, phase, momentum, flags } => self.scroll(dx, dy, phase, momentum, flags),
            Synth::Media { key, down } => self.media(key, down),
            Synth::ToggleCapsLock => self.toggle_caps_lock(),
            Synth::Pause(duration) => std::thread::sleep(duration),
        }
    }

    fn cursor(&mut self) -> (f64, f64) {
        let p = self.current_position();
        (p.x, p.y)
    }

    fn can_post(&mut self) -> bool {
        self.permission.get(CACHE_TTL, has_post_permission)
    }

    fn secure_input(&mut self) -> bool {
        self.secure.get(CACHE_TTL, || unsafe { IsSecureEventInputEnabled() != 0 })
    }
}

/// A FlagsChanged event is a press when the key's own device bit is set in
/// the resulting flags.
fn keycodes_is_down(code: u16, event_flags: u64) -> bool {
    keycodes::modifier(code).is_some_and(|m| {
        let device = m.flags & !keycodes::wire_to_generic_flags(m.wire);
        if device == 0 { event_flags & m.flags != 0 } else { event_flags & device != 0 }
    })
}
