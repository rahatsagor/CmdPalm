//! The deck: pages of buttons that run actions (a Stream Deck on the phone).
//!
//! The Mac stores one deck shared by all devices so a layout built on the
//! iPad also appears on the phone. Clients edit it and send it back whole.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::keycodes::{self, mods};
use crate::protocol::{Action, AppOp, MediaKey, SystemAction};

pub const DECK_VERSION: u32 = 1;
const MAX_PAGES: usize = 24;
const MAX_TILES: usize = 64;
const MAX_TEXT: usize = 4_096;
const MAX_LABEL: usize = 80;
const MAX_STEPS: usize = 64;
const MAX_ID: usize = 128;
const MAX_NAME: usize = 512;
/// The most a whole deck may take as compact JSON in UTF-8. It leaves room for
/// the `deckSave` envelope within the WebSocket message limit.
pub(crate) const MAX_DECK_BYTES: usize = crate::server::MAX_MESSAGE - 4 * 1024;
/// Largest deck file the Mac imports. Exports stay under it.
pub(crate) const MAX_DECK_FILE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_DEPTH: usize = 3;
pub(crate) const MAX_DELAY_MS: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub version: u32,
    pub pages: Vec<DeckPage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckPage {
    pub id: String,
    pub name: String,
    /// Preferred columns on a phone in portrait; tablets scale up.
    #[serde(default = "default_columns")]
    pub columns: u8,
    pub tiles: Vec<Tile>,
}

fn default_columns() -> u8 {
    4
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<TileIcon>,
    /// CSS color for the tile background, e.g. `#3b82f6`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TileIcon {
    /// The icon of a Mac app, by bundle identifier.
    App {
        id: String,
    },
    /// A named glyph from the web client's icon set.
    Symbol {
        name: String,
    },
    Emoji {
        text: String,
    },
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum DeckError {
    #[error("{}", version_message(*.0))]
    Version(u32),
    #[error("That file isn’t a CmdPalm deck, or it’s damaged.")]
    Unreadable,
    #[error(
        "This deck has something this version of CmdPalm can’t read. If it came from a newer CmdPalm, update CmdPalm on this Mac and try again."
    )]
    Unsupported,
    #[error("A deck can have up to {MAX_PAGES} pages, each with up to {MAX_TILES} buttons.")]
    TooLarge,
    #[error("{0}")]
    Invalid(String),
    #[error("This deck is too large to save: it’s {} KB over the limit. Remove some buttons, or shorten long text and sequences.", .0.saturating_sub(MAX_DECK_BYTES).div_ceil(1000).max(1))]
    Oversized(usize),
}

fn version_message(version: u32) -> &'static str {
    if version > DECK_VERSION {
        "This deck was made by a newer version of CmdPalm. Update CmdPalm on this Mac, then try again."
    } else {
        "That file isn’t a deck this version of CmdPalm can read."
    }
}

fn invalid(message: impl Into<String>) -> DeckError {
    DeckError::Invalid(message.into())
}

/// A page or button name to quote in a message, shortened if it's long.
fn quoted(name: &str, unnamed: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return unnamed.into();
    }
    let mut shown: String = name.chars().take(40).collect();
    if shown.len() < name.len() {
        shown.push('…');
    }
    format!("“{shown}”")
}

/// Says where in the deck a problem is, so a person can find and fix it.
fn within(err: DeckError, place: impl FnOnce() -> String) -> DeckError {
    match err {
        DeckError::Invalid(message) => DeckError::Invalid(format!("{message} Check {}.", place())),
        other => other,
    }
}

/// Reads a deck file, explaining in plain words why it can't be used.
pub fn parse(json: &str) -> Result<Deck, DeckError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| DeckError::Unreadable)?;
    let Some(fields) = value.as_object().filter(|fields| fields.contains_key("pages")) else {
        return Err(DeckError::Unreadable);
    };
    // A newer deck may use actions this version doesn't know; say so before
    // failing on one of them.
    if let Some(version) = fields.get("version").and_then(serde_json::Value::as_u64)
        && version != u64::from(DECK_VERSION)
    {
        return Err(DeckError::Version(u32::try_from(version).unwrap_or(u32::MAX)));
    }
    serde_json::from_value(value).map_err(|_| DeckError::Unsupported)
}

impl Deck {
    /// Checked when saving, not when loading, so a deck saved before this
    /// limit existed still opens and can be exported or trimmed.
    pub fn check_size(&self) -> Result<(), DeckError> {
        let bytes = serde_json::to_vec(self).map_or(0, |json| json.len());
        if bytes > MAX_DECK_BYTES { Err(DeckError::Oversized(bytes)) } else { Ok(()) }
    }

    pub fn validate(&self) -> Result<(), DeckError> {
        if self.version != DECK_VERSION {
            return Err(DeckError::Version(self.version));
        }
        if self.pages.is_empty() {
            return Err(invalid("The deck needs at least one page."));
        }
        if self.pages.len() > MAX_PAGES {
            return Err(DeckError::TooLarge);
        }
        let mut pages = HashSet::new();
        for page in &self.pages {
            let page_name = || quoted(&page.name, "an unnamed page");
            let on_page = || format!("the page {}", page_name());
            check_id(&page.id).map_err(|err| within(err, on_page))?;
            if !pages.insert(&page.id) {
                return Err(within(invalid("Two pages have the same ID, so CmdPalm can’t tell them apart."), on_page));
            }
            check_label(&page.name).map_err(|err| within(err, on_page))?;
            if !(1..=8).contains(&page.columns) {
                return Err(within(invalid("Pages can have 1 to 8 columns."), on_page));
            }
            if page.tiles.len() > MAX_TILES {
                return Err(DeckError::TooLarge);
            }
            let mut tiles = HashSet::new();
            for tile in &page.tiles {
                let on_tile =
                    || format!("the button {} on the page {}", quoted(&tile.label, "without a label"), page_name());
                check_id(&tile.id).map_err(|err| within(err, on_tile))?;
                if !tiles.insert(&tile.id) {
                    return Err(within(
                        invalid("Two buttons on one page have the same ID, so CmdPalm can’t tell them apart."),
                        on_tile,
                    ));
                }
                check_label(&tile.label).map_err(|err| within(err, on_tile))?;
                if let Some(icon) = &tile.icon {
                    check_icon(icon).map_err(|err| within(err, on_tile))?;
                }
                if let Some(color) = &tile.color
                    && !is_css_color(color)
                {
                    return Err(within(invalid("Button colors must be hex colors, like #3b82f6."), on_tile));
                }
                validate_action(&tile.action, 0).map_err(|err| within(err, on_tile))?;
            }
        }
        Ok(())
    }
}

fn check_label(label: &str) -> Result<(), DeckError> {
    if label.chars().count() > MAX_LABEL {
        return Err(invalid(format!("Names and labels can be up to {MAX_LABEL} characters.")));
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), DeckError> {
    if id.is_empty() {
        return Err(invalid("Every page and button needs an ID."));
    }
    if id.len() > MAX_ID {
        return Err(invalid(format!("Page and button IDs can be up to {MAX_ID} characters.")));
    }
    Ok(())
}

fn check_icon(icon: &TileIcon) -> Result<(), DeckError> {
    let (text, max) = match icon {
        TileIcon::App { id } => (id, MAX_NAME),
        TileIcon::Symbol { name } => (name, MAX_ID),
        // Room for long emoji sequences such as families and flags.
        TileIcon::Emoji { text } => (text, 64),
    };
    if text.len() > max {
        return Err(invalid("The button’s icon is too long. Choose another icon."));
    }
    Ok(())
}

fn is_css_color(value: &str) -> bool {
    let hex = value.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn validate_action(action: &Action, depth: usize) -> Result<(), DeckError> {
    match action {
        Action::Keys { code, mods: m, char } => {
            if *code > keycodes::MAX_KEYCODE || m & !mods::ALL != 0 || char.as_ref().is_some_and(|c| c.len() > 16) {
                return Err(invalid(
                    "The shortcut uses a key or modifier CmdPalm doesn’t know. Choose the keys again.",
                ));
            }
        }
        Action::Text { text, .. } | Action::Shell { command: text } => {
            if text.len() > MAX_TEXT {
                return Err(invalid("Text to type and shell commands can be up to 4 KB."));
            }
        }
        Action::Url { url } => {
            if url.len() > MAX_TEXT {
                return Err(invalid("Links can be up to 4 KB."));
            }
            if !url.contains(':') {
                return Err(invalid("Enter a full link, like https://example.com."));
            }
        }
        Action::App { id, .. } => {
            if id.is_empty() || id.len() > MAX_NAME {
                return Err(invalid("Choose an app for the button to use."));
            }
        }
        Action::Shortcut { name } => {
            if name.is_empty() {
                return Err(invalid("Enter the name of a shortcut from the Shortcuts app."));
            }
            if name.len() > MAX_NAME {
                return Err(invalid("The shortcut name is too long."));
            }
        }
        Action::Delay { ms } => {
            if *ms > MAX_DELAY_MS {
                return Err(invalid("Waits can be up to 10 seconds."));
            }
        }
        Action::Mouse { clicks, .. } => {
            if !(1..=3).contains(clicks) {
                return Err(invalid("Clicks can be single, double or triple."));
            }
        }
        Action::Sequence { steps } => {
            if steps.len() > MAX_STEPS {
                return Err(invalid(format!("Sequences can have up to {MAX_STEPS} steps.")));
            }
            if depth >= MAX_DEPTH {
                return Err(invalid(format!("Sequences can be nested up to {MAX_DEPTH} levels deep.")));
            }
            for step in steps {
                validate_action(step, depth + 1)?;
            }
        }
        Action::Media { .. } | Action::System { .. } => {}
    }
    Ok(())
}

fn tile(id: &str, label: &str, icon: TileIcon, action: Action) -> Tile {
    Tile { id: id.into(), label: label.into(), icon: Some(icon), color: None, action }
}

fn symbol(name: &str) -> TileIcon {
    TileIcon::Symbol { name: name.into() }
}

fn system(name: SystemAction) -> Action {
    Action::System { name }
}

fn media(key: MediaKey) -> Action {
    Action::Media { key }
}

fn app(id: &str) -> (TileIcon, Action) {
    (TileIcon::App { id: id.into() }, Action::App { id: id.into(), op: AppOp::Toggle })
}

impl Default for Deck {
    fn default() -> Self {
        use SystemAction as S;
        let essentials = vec![
            tile("mission-control", "Mission Control", symbol("layout-grid"), system(S::MissionControl)),
            tile("app-expose", "App Windows", symbol("app-window"), system(S::AppExpose)),
            tile("desktop", "Desktop", symbol("monitor"), system(S::ShowDesktop)),
            tile("spotlight", "Spotlight", symbol("search"), system(S::Spotlight)),
            tile("space-left", "Space Left", symbol("arrow-left-to-line"), system(S::SpaceLeft)),
            tile("space-right", "Space Right", symbol("arrow-right-to-line"), system(S::SpaceRight)),
            tile("screenshot", "Screenshot", symbol("scan"), system(S::ScreenshotArea)),
            tile("lock", "Lock", symbol("lock"), system(S::LockScreen)),
            tile("previous", "Previous", symbol("skip-back"), media(MediaKey::Previous)),
            tile("play", "Play / Pause", symbol("play-pause"), media(MediaKey::PlayPause)),
            tile("next", "Next", symbol("skip-forward"), media(MediaKey::Next)),
            tile("mute", "Mute", symbol("volume-x"), media(MediaKey::Mute)),
            tile("copy", "Copy", symbol("copy"), system(S::Copy)),
            tile("paste", "Paste", symbol("clipboard"), system(S::Paste)),
            tile("undo", "Undo", symbol("undo"), system(S::Undo)),
            tile("emoji", "Emoji", symbol("smile"), system(S::EmojiPicker)),
        ];
        let apps = [
            ("com.apple.finder", "Finder"),
            ("com.apple.Safari", "Safari"),
            ("com.apple.Terminal", "Terminal"),
            ("com.apple.Music", "Music"),
            ("com.apple.MobileSMS", "Messages"),
            ("com.apple.Notes", "Notes"),
            ("com.apple.iCal", "Calendar"),
            ("com.apple.systempreferences", "Settings"),
        ]
        .into_iter()
        .map(|(id, label)| {
            let (icon, action) = app(id);
            tile(id, label, icon, action)
        })
        .collect();
        Deck {
            version: DECK_VERSION,
            pages: vec![
                DeckPage { id: "essentials".into(), name: "Essentials".into(), columns: 4, tiles: essentials },
                DeckPage { id: "apps".into(), name: "Apps".into(), columns: 4, tiles: apps },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_deck_is_valid_and_round_trips() {
        let deck = Deck::default();
        deck.validate().unwrap();
        let json = serde_json::to_string(&deck).unwrap();
        let back: Deck = serde_json::from_str(&json).unwrap();
        assert_eq!(back, deck);
        assert!(json.contains(r#""icon":{"kind":"app","id":"com.apple.finder"}"#));
    }

    #[test]
    fn rejects_hostile_decks() {
        let mut deck = Deck::default();
        deck.pages[0].tiles[0].color = Some("red;background:url(x)".into());
        assert!(deck.validate().is_err());

        let mut deck = Deck::default();
        let mut action = Action::Delay { ms: 1 };
        for _ in 0..5 {
            action = Action::Sequence { steps: vec![action] };
        }
        deck.pages[0].tiles[0].action = action;
        assert!(deck.validate().is_err());

        let mut deck = Deck::default();
        deck.pages[0].tiles[0].action = Action::Keys { code: 0x200, mods: 0, char: None };
        assert!(deck.validate().is_err());

        let deck = Deck { version: 99, pages: vec![] };
        assert_eq!(deck.validate(), Err(DeckError::Version(99)));

        let deck = Deck { version: DECK_VERSION, pages: vec![] };
        assert_eq!(deck.validate(), Err(DeckError::Invalid("The deck needs at least one page.".into())));
    }

    #[test]
    fn deck_files_say_why_they_cant_be_imported() {
        let deck = Deck::default();
        assert_eq!(parse(&serde_json::to_string_pretty(&deck).unwrap()), Ok(deck));
        for unreadable in ["", "{not json", "[]", r#"{"version": 1}"#] {
            assert_eq!(parse(unreadable), Err(DeckError::Unreadable), "{unreadable:?}");
        }
        let newer = r#"{"version": 2, "pages": [{"id": "p", "name": "P", "tiles": [{"kind": "hologram"}]}]}"#;
        let err = parse(newer).unwrap_err();
        assert_eq!(err, DeckError::Version(2));
        assert!(err.to_string().contains("newer version of CmdPalm"), "{err}");
        let unknown = r#"{"version": 1, "pages": [{"id": "p", "name": "P", "tiles": [
            {"id": "t", "label": "T", "action": {"kind": "teleport"}}]}]}"#;
        assert_eq!(parse(unknown), Err(DeckError::Unsupported));
    }

    #[test]
    fn problems_name_the_page_and_button_to_fix() {
        let mut deck = Deck::default();
        deck.pages[0].tiles[0].color = Some("red".into());
        assert_eq!(
            deck.validate().unwrap_err().to_string(),
            "Button colors must be hex colors, like #3b82f6. Check the button “Mission Control” on the page “Essentials”."
        );

        let mut deck = Deck::default();
        deck.pages[1].tiles[0].label.clear();
        deck.pages[1].tiles[0].action =
            Action::Sequence { steps: vec![Action::Mouse { button: crate::protocol::MouseButton::Left, clicks: 4 }] };
        assert_eq!(
            deck.validate().unwrap_err().to_string(),
            "Clicks can be single, double or triple. Check the button without a label on the page “Apps”."
        );

        let mut deck = Deck::default();
        deck.pages[0].name = "x".repeat(81);
        let message = deck.validate().unwrap_err().to_string();
        assert!(message.ends_with(&format!("Check the page “{}…”.", "x".repeat(40))), "{message}");
    }

    #[test]
    fn rejects_ambiguous_page_and_button_ids() {
        let mut deck = Deck::default();
        deck.pages[1].id = deck.pages[0].id.clone();
        assert!(deck.validate().is_err());

        let mut deck = Deck::default();
        deck.pages[0].tiles[1].id = deck.pages[0].tiles[0].id.clone();
        assert!(deck.validate().is_err());

        let mut deck = Deck::default();
        deck.pages[0].id.clear();
        assert!(deck.validate().is_err());
        let mut deck = Deck::default();
        deck.pages[0].tiles[0].id.clear();
        assert!(deck.validate().is_err());
    }
}
