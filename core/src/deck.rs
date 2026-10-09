//! The deck: pages of buttons that run actions (a Stream Deck on the phone).
//!
//! The Mac stores one deck shared by all devices so a layout built on the
//! iPad also appears on the phone. Clients edit it and send it back whole.

use serde::{Deserialize, Serialize};

use crate::keycodes::{self, mods};
use crate::protocol::{Action, AppOp, MediaKey, SystemAction};

pub const DECK_VERSION: u32 = 1;
const MAX_PAGES: usize = 24;
const MAX_TILES: usize = 64;
const MAX_TEXT: usize = 4_096;
const MAX_LABEL: usize = 80;
const MAX_STEPS: usize = 64;
const MAX_DEPTH: usize = 3;
const MAX_DELAY_MS: u32 = 10_000;

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
    #[error("unsupported deck version {0}")]
    Version(u32),
    #[error("the deck has too many pages or buttons")]
    TooLarge,
    #[error("{0}")]
    Invalid(String),
}

impl Deck {
    pub fn validate(&self) -> Result<(), DeckError> {
        if self.version != DECK_VERSION {
            return Err(DeckError::Version(self.version));
        }
        if self.pages.is_empty() || self.pages.len() > MAX_PAGES {
            return Err(DeckError::TooLarge);
        }
        for page in &self.pages {
            check_label(&page.name)?;
            if !(1..=8).contains(&page.columns) {
                return Err(DeckError::Invalid("columns must be between 1 and 8".into()));
            }
            if page.tiles.len() > MAX_TILES {
                return Err(DeckError::TooLarge);
            }
            for tile in &page.tiles {
                check_label(&tile.label)?;
                if let Some(color) = &tile.color
                    && !is_css_color(color)
                {
                    return Err(DeckError::Invalid(format!("invalid color {color:?}")));
                }
                validate_action(&tile.action, 0)?;
            }
        }
        Ok(())
    }
}

fn check_label(label: &str) -> Result<(), DeckError> {
    if label.chars().count() > MAX_LABEL {
        return Err(DeckError::Invalid("label is too long".into()));
    }
    Ok(())
}

fn is_css_color(value: &str) -> bool {
    let hex = value.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn validate_action(action: &Action, depth: usize) -> Result<(), DeckError> {
    match action {
        Action::Keys { code, mods: m, .. } => {
            if *code > keycodes::MAX_KEYCODE || m & !mods::ALL != 0 {
                return Err(DeckError::Invalid("invalid key".into()));
            }
        }
        Action::Text { text, .. } | Action::Shell { command: text } => {
            if text.len() > MAX_TEXT {
                return Err(DeckError::Invalid("text is too long".into()));
            }
        }
        Action::Url { url } => {
            if url.len() > MAX_TEXT || !url.contains(':') {
                return Err(DeckError::Invalid("invalid URL".into()));
            }
        }
        Action::App { id, .. } | Action::Shortcut { name: id } => {
            if id.is_empty() || id.len() > 512 {
                return Err(DeckError::Invalid("missing name".into()));
            }
        }
        Action::Delay { ms } => {
            if *ms > MAX_DELAY_MS {
                return Err(DeckError::Invalid("delays are limited to 10 seconds".into()));
            }
        }
        Action::Mouse { clicks, .. } => {
            if !(1..=3).contains(clicks) {
                return Err(DeckError::Invalid("clicks must be 1–3".into()));
            }
        }
        Action::Sequence { steps } => {
            if depth >= MAX_DEPTH || steps.len() > MAX_STEPS {
                return Err(DeckError::Invalid("sequence is too long or nested too deeply".into()));
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
    }
}
