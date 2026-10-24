//! Running deck actions. Each device has one worker so a button's steps
//! never interleave with the next button's.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::api::NativeCommand;
use crate::deck::{MAX_DELAY_MS, MAX_DEPTH};
use crate::host::Shared;
use crate::input::{Command, Input, Interrupts, SessionId, TypeMode};
use crate::keycodes::{self as kc, KeyCode, mods};
use crate::protocol::{Action, MouseButton, PressOp, ServerMessage, SystemAction};

pub(crate) struct Job {
    pub action: Action,
    pub id: Option<u32>,
}

/// How long the pasted text stays on the clipboard before it is restored.
/// Apps read the pasteboard asynchronously after ⌘V.
const PASTE_RESTORE_DELAY: Duration = Duration::from_millis(450);
const DELAY_SLICE: Duration = Duration::from_millis(50);
const STOPPED: &str = "Stopped because control was paused or the device disconnected.";
const SHELL_POLL: Duration = Duration::from_millis(100);
const SHELL_KILL_GRACE: Duration = Duration::from_secs(1);

pub(crate) async fn worker(shared: Arc<Shared>, session: SessionId, mut jobs: mpsc::Receiver<Job>) {
    while let Some(job) = jobs.recv().await {
        let task_shared = shared.clone();
        let action = job.action;
        let result = tokio::task::spawn_blocking(move || execute(&task_shared, session, &action, 0))
            .await
            .unwrap_or_else(|_| Err("The action crashed.".into()));
        if job.id.is_some() || result.is_err() {
            let (ok, message) = match result {
                Ok(()) => (true, None),
                Err(message) => (false, Some(message)),
            };
            shared.send_to(session, ServerMessage::ActionResult { id: job.id, ok, message });
        }
    }
}

fn input(shared: &Shared, session: SessionId, input: Input) {
    shared.engine(Command::Input { session, input });
}

enum Plan {
    Code(KeyCode, u16),
    Letter(char, KeyCode, u16),
    Native(NativeCommand),
}

fn system_plan(name: SystemAction) -> Plan {
    use SystemAction as S;
    use mods::{COMMAND as CMD, CONTROL as CTRL, OPTION as OPT, SHIFT};
    let letter = |ch: char, mods: u16| {
        let code = kc::named_key(&ch.to_string()).unwrap_or(kc::KEY_A);
        Plan::Letter(ch, code, mods)
    };
    match name {
        S::MissionControl => Plan::Native(NativeCommand::MissionControl),
        S::Launchpad => Plan::Native(NativeCommand::Launchpad),
        S::LockScreen => Plan::Native(NativeCommand::LockScreen),
        S::SleepDisplay => Plan::Native(NativeCommand::SleepDisplay),
        S::Sleep => Plan::Native(NativeCommand::Sleep),
        S::AppExpose => Plan::Code(kc::KEY_DOWN, CTRL),
        // F11 is the default Show Desktop shortcut.
        S::ShowDesktop => Plan::Code(0x67, 0),
        S::Spotlight => Plan::Code(kc::KEY_SPACE, CMD),
        S::SpaceLeft => Plan::Code(kc::KEY_LEFT, CTRL),
        S::SpaceRight => Plan::Code(kc::KEY_RIGHT, CTRL),
        S::AppSwitcher => Plan::Code(kc::KEY_TAB, CMD),
        // Screenshot shortcuts are bound to key positions, not characters.
        S::Screenshot => Plan::Code(kc::KEY_3, CMD | SHIFT),
        S::ScreenshotArea => Plan::Code(kc::KEY_4, CMD | SHIFT),
        S::ScreenshotTool => Plan::Code(kc::KEY_5, CMD | SHIFT),
        S::ForceQuit => Plan::Code(kc::KEY_ESCAPE, CMD | OPT),
        S::EmojiPicker => Plan::Code(kc::KEY_SPACE, CTRL | CMD),
        S::CloseWindow | S::CloseTab => letter('w', CMD),
        S::QuitApp => letter('q', CMD),
        S::Minimize => letter('m', CMD),
        S::HideApp => letter('h', CMD),
        S::Fullscreen => letter('f', CTRL | CMD),
        S::Undo => letter('z', CMD),
        S::Redo => letter('z', CMD | SHIFT),
        S::Copy => letter('c', CMD),
        S::Cut => letter('x', CMD),
        S::Paste => letter('v', CMD),
        S::SelectAll => letter('a', CMD),
        S::Find => letter('f', CMD),
        S::NewTab => letter('t', CMD),
        S::Reload => letter('r', CMD),
        S::NextTab => Plan::Code(kc::KEY_TAB, CTRL),
        S::PreviousTab => Plan::Code(kc::KEY_TAB, CTRL | SHIFT),
        S::Back => Plan::Code(kc::KEY_LEFT_BRACKET, CMD),
        S::Forward => Plan::Code(kc::KEY_RIGHT_BRACKET, CMD),
        S::ZoomIn => Plan::Code(kc::KEY_EQUAL, CMD),
        S::ZoomOut => Plan::Code(kc::KEY_MINUS, CMD),
        S::ActualSize => Plan::Code(0x1D, CMD),
    }
}

fn single_letter(text: &str) -> Option<char> {
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_alphabetic() => Some(c),
        _ => None,
    }
}

pub(crate) fn paste(shared: &Shared, session: SessionId, text: &str) -> Result<(), String> {
    let _serial = shared.paste_lock.lock().unwrap_or_else(|p| p.into_inner());
    if shared.should_stop(session) {
        return Ok(());
    }
    if !shared.delegate.begin_paste(text.to_string()) {
        return Err("Couldn't use the clipboard.".into());
    }
    input(shared, session, Input::CharTap { ch: 'v', fallback: kc::KEY_V, mods: mods::COMMAND });
    // Restoring the clipboard before ⌘V is posted, say behind a long text
    // from another device, would paste the person's previous clipboard.
    shared.finish_engine();
    std::thread::sleep(PASTE_RESTORE_DELAY);
    shared.delegate.end_paste();
    Ok(())
}

fn url_allowed(url: &str, allow_shell: bool) -> bool {
    let Some((scheme, _)) = url.split_once(':') else { return false };
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return false;
    }
    match scheme.as_str() {
        "javascript" | "data" => false,
        // A file URL can launch scripts; treat it like a shell command.
        "file" => allow_shell,
        _ => true,
    }
}

/// Runs one action. Steps stop as soon as the device disconnects or input is
/// paused, even partway through a long sequence.
pub(crate) fn execute(shared: &Shared, session: SessionId, action: &Action, depth: usize) -> Result<(), String> {
    if shared.should_stop(session) {
        return Err(STOPPED.into());
    }
    match action {
        Action::Keys { code, mods, char } => {
            let input_event = match char.as_deref().and_then(single_letter) {
                Some(ch) => Input::CharTap { ch, fallback: *code, mods: *mods },
                None => Input::Tap { code: *code, mods: *mods },
            };
            input(shared, session, input_event);
        }
        Action::Text { text, enter } => {
            input(shared, session, Input::Text { text: text.clone(), mode: TypeMode::Unicode });
            if *enter {
                input(shared, session, Input::Tap { code: kc::KEY_RETURN, mods: 0 });
            }
        }
        Action::Media { key } => input(shared, session, Input::Media { key: *key, op: PressOp::Click }),
        Action::App { id, op } => {
            if !shared.delegate.app_action(id.clone(), *op) {
                return Err(format!("Couldn't find the app “{id}” on the Mac."));
            }
        }
        Action::Url { url } => {
            if !url_allowed(url, shared.config().allow_shell) {
                return Err("That kind of link isn't allowed.".into());
            }
            if !shared.delegate.open_url(url.clone()) {
                return Err("The Mac couldn't open that link.".into());
            }
        }
        Action::System { name } => match system_plan(*name) {
            Plan::Code(code, mods) => input(shared, session, Input::Tap { code, mods }),
            Plan::Letter(ch, fallback, mods) => input(shared, session, Input::CharTap { ch, fallback, mods }),
            Plan::Native(command) => {
                // Let pending keystrokes land before the screen locks or sleeps.
                shared.flush_engine();
                if !shared.delegate.native(command) {
                    return Err("The Mac couldn't do that.".into());
                }
            }
        },
        Action::Shortcut { name } => {
            if !shared.delegate.run_shortcut(name.clone()) {
                return Err(format!("Couldn't run the shortcut “{name}”."));
            }
        }
        Action::Shell { command } => {
            if !shared.config().allow_shell {
                return Err("Shell commands are turned off. Turn them on in CmdPalm settings on the Mac.".into());
            }
            run_shell(command, shared.interrupts.clone())?;
        }
        Action::Mouse { button, clicks } => {
            let button: MouseButton = *button;
            input(shared, session, Input::Click { button, clicks: (*clicks).clamp(1, 3), mods: 0 });
        }
        Action::Delay { ms } => {
            shared.flush_engine();
            let until = Instant::now() + Duration::from_millis((*ms).min(MAX_DELAY_MS) as u64);
            while let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
                if shared.should_stop(session) {
                    return Err(STOPPED.into());
                }
                std::thread::sleep(left.min(DELAY_SLICE));
            }
        }
        Action::Sequence { steps } => {
            if depth >= MAX_DEPTH {
                return Err("The sequence is nested too deeply.".into());
            }
            for step in steps {
                execute(shared, session, step, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn run_shell(command: &str, interrupts: Arc<Interrupts>) -> Result<(), String> {
    use std::os::unix::process::CommandExt as _;
    let mut child = std::process::Command::new("/bin/zsh")
        .arg("-lc")
        .arg(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own process group, so Pause can stop everything it started.
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Couldn't run the command: {e}"))?;
    let group = child.id() as libc::pid_t;
    // Reap the process when it finishes so it never lingers as a zombie, and
    // stop it if input is paused while it runs: the command inherits CmdPalm's
    // Accessibility permission, so it must not outlive Pause.
    std::thread::spawn(move || {
        let mut signalled: Option<Instant> = None;
        while let Ok(None) = child.try_wait() {
            if interrupts.paused() {
                match signalled {
                    None => {
                        // SAFETY: signals only the process group created above.
                        unsafe { libc::killpg(group, libc::SIGTERM) };
                        signalled = Some(Instant::now());
                    }
                    Some(at) if at.elapsed() >= SHELL_KILL_GRACE => {
                        // SAFETY: as above.
                        unsafe { libc::killpg(group, libc::SIGKILL) };
                    }
                    Some(_) => {}
                }
            }
            std::thread::sleep(SHELL_POLL);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_follow_the_layout_but_digits_use_positions() {
        assert!(matches!(system_plan(SystemAction::Copy), Plan::Letter('c', kc::KEY_C, mods::COMMAND)));
        assert!(
            matches!(system_plan(SystemAction::ScreenshotArea), Plan::Code(kc::KEY_4, m) if m == mods::COMMAND | mods::SHIFT)
        );
        assert_eq!(single_letter("q"), Some('q'));
        assert_eq!(single_letter("["), None);
        assert_eq!(single_letter("qq"), None);
    }

    #[test]
    fn file_links_need_shell_permission() {
        assert!(url_allowed("https://example.com", false));
        assert!(url_allowed("raycast://extensions", false));
        assert!(!url_allowed("file:///tmp/x.command", false));
        assert!(url_allowed("file:///tmp/x.command", true));
        assert!(!url_allowed("no scheme", false));
        assert!(!url_allowed("JavaScript:alert(1)", true));
        assert!(!url_allowed("data:text/html,hi", true));
    }

    #[test]
    fn pause_stops_running_shell_commands() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let interrupts = Arc::new(Interrupts::default());
        run_shell(&format!("sleep 2; touch '{}'", marker.display()), interrupts.clone()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        interrupts.set_paused(true);
        std::thread::sleep(Duration::from_millis(2600));
        assert!(!marker.exists(), "the paused command never finished");
    }
}
