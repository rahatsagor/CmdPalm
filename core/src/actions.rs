//! Running deck actions. Each device has one worker so a button's steps
//! never interleave with the next button's.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

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
const SHELL_POLL: Duration = Duration::from_millis(50);
const SHELL_KILL_GRACE: Duration = Duration::from_secs(1);
/// How long a button waits for its shell command before carrying on, so a
/// command that fails right away can say why on the phone.
const SHELL_REPORT_WINDOW: Duration = Duration::from_millis(1500);
/// How much of a failed command's error output the phone is shown.
const SHELL_ERROR_CHARS: usize = 240;
const SHELL_ERROR_READ: u64 = 16 * 1024;
/// Commands whose process group is still being watched. Each has a thread,
/// so a button pressed over and over can't pile up threads without end.
const MAX_RUNNING_COMMANDS: usize = 32;
static RUNNING_COMMANDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

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
        S::LookUp => letter('d', CTRL | CMD),
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

/// `queued` is told (or dropped) once ⌘V is in the input queue, so input the
/// device sends after the paste can't be posted before it.
pub(crate) fn paste(
    shared: &Shared,
    session: SessionId,
    text: &str,
    queued: oneshot::Sender<()>,
) -> Result<(), String> {
    let _serial = shared.paste_lock.lock().unwrap_or_else(|p| p.into_inner());
    if shared.should_stop(session) {
        return Ok(());
    }
    if !shared.delegate.begin_paste(text.to_string()) {
        return Err("Couldn't use the clipboard.".into());
    }
    input(shared, session, Input::CharTap { ch: 'v', fallback: kc::KEY_V, mods: mods::COMMAND });
    let _ = queued.send(());
    // Restoring the clipboard before ⌘V is posted, say behind a long text
    // from another device, would paste the person's previous clipboard.
    shared.finish_engine();
    std::thread::sleep(PASTE_RESTORE_DELAY);
    shared.delegate.end_paste();
    Ok(())
}

/// Why a link can't be opened, or `None` when it can.
fn link_problem(url: &str, allow_shell: bool) -> Option<&'static str> {
    const NOT_ALLOWED: &str = "That kind of link isn't allowed.";
    let Some((scheme, _)) = url.trim().split_once(':') else { return Some(NOT_ALLOWED) };
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return Some(NOT_ALLOWED);
    }
    match scheme.as_str() {
        "javascript" | "data" => Some(NOT_ALLOWED),
        // A file URL can launch scripts, and these open a terminal or connect
        // to a file server, which can hand over the Mac's login. Treat them
        // like shell commands.
        "file" | "ssh" | "telnet" | "x-man-page" | "smb" | "cifs" | "afp" | "nfs" | "ftp" if !allow_shell => Some(
            "Links to files, terminals and file servers need shell commands turned on in CmdPalm settings on the Mac.",
        ),
        _ => None,
    }
}

/// Waits for the input queued before a step that acts outside the engine, so
/// an app never comes forward mid-typing and a shortcut never reads the
/// clipboard before ⌘C lands.
fn settle(shared: &Shared, session: SessionId) -> Result<(), String> {
    shared.flush_engine();
    if shared.should_stop(session) {
        return Err(STOPPED.into());
    }
    Ok(())
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
            settle(shared, session)?;
            if !shared.delegate.app_action(id.clone(), *op) {
                return Err(format!(
                    "Couldn't finish the action for “{id}”. The app may still be starting or waiting for a dialog."
                ));
            }
        }
        Action::Url { url } => {
            let url = url.trim();
            if let Some(problem) = link_problem(url, shared.config().allow_shell) {
                return Err(problem.into());
            }
            settle(shared, session)?;
            if !shared.delegate.open_url(url.to_string()) {
                return Err("The Mac couldn't open that link.".into());
            }
        }
        Action::System { name } => match system_plan(*name) {
            Plan::Code(code, mods) => input(shared, session, Input::Tap { code, mods }),
            Plan::Letter(ch, fallback, mods) => input(shared, session, Input::CharTap { ch, fallback, mods }),
            Plan::Native(command) => {
                // Let pending keystrokes land before the screen locks or sleeps,
                // and don't lock or sleep if Pause was pressed meanwhile.
                settle(shared, session)?;
                if !shared.delegate.native(command) {
                    return Err("The Mac couldn't do that.".into());
                }
            }
        },
        Action::Shortcut { name } => {
            settle(shared, session)?;
            if !shared.delegate.run_shortcut(name.clone()) {
                return Err(format!("Couldn't run the shortcut “{name}”."));
            }
        }
        Action::Shell { command } => {
            if !shared.config().allow_shell {
                return Err("Shell commands are turned off. Turn them on in CmdPalm settings on the Mac.".into());
            }
            settle(shared, session)?;
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
    use std::process::Stdio;
    use std::sync::atomic::Ordering;
    if RUNNING_COMMANDS.fetch_add(1, Ordering::SeqCst) >= MAX_RUNNING_COMMANDS {
        RUNNING_COMMANDS.fetch_sub(1, Ordering::SeqCst);
        return Err("Too many shell commands are still running. Pause CmdPalm on the Mac to stop them.".into());
    }
    struct Running;
    impl Drop for Running {
        fn drop(&mut self) {
            RUNNING_COMMANDS.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let running = Running;
    let errors = error_file();
    let stderr = errors.as_ref().and_then(|f| f.try_clone().ok()).map_or_else(Stdio::null, Stdio::from);
    let mut child = std::process::Command::new("/bin/zsh")
        .arg("-lc")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        // Its own process group, so Pause can stop everything it started.
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Couldn't run the command: {e}"))?;
    let group = child.id() as libc::pid_t;
    let (done, finished) = std::sync::mpsc::channel();
    // Reap the process when it finishes so it never lingers as a zombie, and
    // stop it if input is paused or shell commands are turned off while it
    // runs: the command inherits CmdPalm's Accessibility permission, so it
    // must not outlive either. That includes what it left running in the
    // background (`cmd &`, `nohup`), so the watch goes on until its whole
    // process group is gone.
    let stops = interrupts.shell_stops();
    std::thread::spawn(move || {
        let _running = running;
        let stopped = || interrupts.paused() || interrupts.shell_stops() != stops;
        let mut signalled: Option<Instant> = None;
        let mut shell_done = false;
        loop {
            if !shell_done {
                let status = match child.try_wait() {
                    Ok(None) => None,
                    Ok(Some(status)) => Some(Some(status)),
                    Err(_) => Some(None),
                };
                if let Some(status) = status {
                    shell_done = true;
                    let _ = done.send((status, stopped()));
                }
            }
            // SAFETY: signal 0 only checks whether the group created above
            // still has members.
            if shell_done && unsafe { libc::killpg(group, 0) } != 0 {
                break;
            }
            if stopped() {
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
    match finished.recv_timeout(SHELL_REPORT_WINDOW) {
        Ok((_, true)) => Err(STOPPED.into()),
        Ok((Some(status), false)) if !status.success() => Err(shell_failure(status, errors)),
        // Still running, or finished fine: the command carries on by itself.
        _ => Ok(()),
    }
}

/// An unlinked temporary file for a command's error output. Unlike a pipe,
/// it never fills up, so a long-running command can't block on it or be
/// killed writing to it after CmdPalm stopped reading.
fn error_file() -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "cmdpalm-shell-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let file = std::fs::OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(file)
}

/// Explains a failed command with the last line it wrote to standard error,
/// which is usually the reason, such as "command not found".
fn shell_failure(status: std::process::ExitStatus, errors: Option<std::fs::File>) -> String {
    use std::io::{Read as _, Seek as _};
    let detail = errors.and_then(|mut file| {
        file.seek(std::io::SeekFrom::Start(0)).ok()?;
        let mut bytes = Vec::new();
        file.take(SHELL_ERROR_READ).read_to_end(&mut bytes).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let line = text.lines().map(str::trim).rfind(|line| !line.is_empty())?;
        let mut line: String = line.chars().take(SHELL_ERROR_CHARS).collect();
        if line.chars().count() == SHELL_ERROR_CHARS {
            line.push('…');
        }
        Some(line)
    });
    let how = match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "stopped by a signal".into(),
    };
    match detail {
        Some(detail) => format!("The command failed ({how}): {detail}"),
        None => format!("The command failed ({how})."),
    }
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
    fn file_terminal_and_file_server_links_need_shell_permission() {
        let allowed = |url: &str, shell: bool| link_problem(url, shell).is_none();
        assert!(allowed("https://example.com", false));
        assert!(allowed(" https://example.com\n", false), "pasted links often carry spaces");
        assert!(allowed("raycast://extensions", false));
        assert!(!allowed("file:///tmp/x.command", false));
        assert!(allowed("file:///tmp/x.command", true));
        for url in ["ssh://host", "SMB://server/share", "afp://server", "x-man-page://ls"] {
            assert!(!allowed(url, false), "{url}");
            assert!(allowed(url, true), "{url}");
        }
        assert!(!allowed("no scheme", false));
        assert!(!allowed("JavaScript:alert(1)", true));
        assert!(!allowed("data:text/html,hi", true));
    }

    #[test]
    fn pause_stops_running_shell_commands() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let interrupts = Arc::new(Interrupts::default());
        // Still running when the button stops waiting for it.
        run_shell(&format!("sleep 3; touch '{}'", marker.display()), interrupts.clone()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        interrupts.set_paused(true);
        std::thread::sleep(Duration::from_millis(2600));
        assert!(!marker.exists(), "the paused command never finished");
    }

    #[test]
    fn turning_shell_commands_off_stops_the_running_ones() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let interrupts = Arc::new(Interrupts::default());
        run_shell(&format!("sleep 3; touch '{}'", marker.display()), interrupts.clone()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        interrupts.stop_shell_commands();
        std::thread::sleep(Duration::from_millis(2600));
        assert!(!marker.exists(), "the command was stopped");
        let later = dir.path().join("later");
        run_shell(&format!("touch '{}'", later.display()), interrupts).unwrap();
        assert!(later.exists(), "commands started after turning them on again run");
    }

    #[test]
    fn pause_stops_what_a_shell_command_left_running() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let interrupts = Arc::new(Interrupts::default());
        // The shell exits at once; its background job carries on.
        run_shell(&format!("(sleep 2; touch '{}') &", marker.display()), interrupts.clone()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        interrupts.set_paused(true);
        std::thread::sleep(Duration::from_millis(2600));
        assert!(!marker.exists(), "the background job was stopped");
    }

    #[test]
    fn shell_commands_can_chain_and_redirect() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let path = log.display();
        let command = format!("echo one >> '{path}'; echo two >> '{path}' && cat '{path}' | wc -l >> '{path}'");
        run_shell(&command, Arc::new(Interrupts::default())).unwrap();
        let written = std::fs::read_to_string(&log).unwrap();
        assert_eq!(written.lines().map(str::trim).collect::<Vec<_>>(), ["one", "two", "2"]);
    }

    #[test]
    fn a_failing_shell_command_says_why() {
        let interrupts = Arc::new(Interrupts::default());
        let error = run_shell("echo first >&2; echo 'no such thing' >&2; exit 3", interrupts.clone()).unwrap_err();
        assert_eq!(error, "The command failed (exit code 3): no such thing");
        let error = run_shell("exit 1", interrupts).unwrap_err();
        assert_eq!(error, "The command failed (exit code 1).");
    }
}
