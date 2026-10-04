#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

// ── Error reporting ───────────────────────────────────────────────────────────

#[cfg(windows)]
fn show_error_dialog(title: &str, message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title_w: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
    let msg_w: Vec<u16> = OsStr::new(message).encode_wide().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            HWND::default(),
            windows::core::PCWSTR(msg_w.as_ptr()),
            windows::core::PCWSTR(title_w.as_ptr()),
            MB_ICONERROR | MB_OK,
        );
    }
}

#[cfg(not(windows))]
fn show_error_dialog(_title: &str, message: &str) {
    eprintln!("{message}");
}

fn log_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("Agentistics").join("agentistics.log")
}

fn log_error(msg: &str) {
    let path = log_path();
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let line = format!("[{}] {}\n", chrono_now(), msg);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("Agentistics crashed: {info}");
        log_error(&msg);
        let log = log_path();
        show_error_dialog(
            "Agentistics — Fatal Error",
            &format!("{msg}\n\nDetails written to:\n{}", log.display()),
        );
    }));
}

const HEALTH_URL: &str = "http://127.0.0.1:47291/api/health";
const DASHBOARD_URL: &str = "http://127.0.0.1:47291";

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Config {
    claude_dir: String,
}

fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("Agentistics").join("config.json")
}

fn read_config(path: &Path) -> Option<Config> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_config(path: &Path, config: &Config) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string_pretty(config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

// ── Source detection ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
struct ClaudeSource {
    label: String,
    path: String,
    kind: String, // "windows" | "wsl"
}

fn detect_sources() -> Vec<ClaudeSource> {
    let mut sources = Vec::new();

    // Windows native
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let claude = PathBuf::from(&userprofile).join(".claude");
        if claude.exists() {
            sources.push(ClaudeSource {
                label: format!("Windows — {}", claude.display()),
                path: claude.to_string_lossy().into_owned(),
                kind: "windows".to_string(),
            });
        }
    }

    // WSL distros — wsl.exe outputs UTF-16LE
    if let Ok(out) = std::process::Command::new("wsl")
        .args(["--list", "--quiet"])
        .output()
    {
        let text = decode_wsl_output(&out.stdout);
        for line in text.lines() {
            let distro = line.trim().trim_end_matches(" (Default)").trim();
            if distro.is_empty() {
                continue;
            }

            // Check each user home inside the distro
            let home_base = format!("\\\\wsl.localhost\\{}\\home", distro);
            if let Ok(entries) = std::fs::read_dir(&home_base) {
                for entry in entries.flatten() {
                    let claude = entry.path().join(".claude");
                    if claude.exists() {
                        sources.push(ClaudeSource {
                            label: format!(
                                "WSL {} / {} — {}",
                                distro,
                                entry.file_name().to_string_lossy(),
                                claude.display()
                            ),
                            path: claude.to_string_lossy().into_owned(),
                            kind: "wsl".to_string(),
                        });
                    }
                }
            }

            // root home
            let root_claude = format!("\\\\wsl.localhost\\{}\\root\\.claude", distro);
            if Path::new(&root_claude).exists() {
                sources.push(ClaudeSource {
                    label: format!("WSL {} / root — {}", distro, root_claude),
                    path: root_claude,
                    kind: "wsl".to_string(),
                });
            }
        }
    }

    sources
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    // wsl --list outputs UTF-16LE (sometimes with BOM)
    let start = if bytes.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
    let slice = &bytes[start..];
    if slice.len() % 2 == 0 && slice.len() >= 2 {
        let utf16: Vec<u16> = slice
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16_lossy(&utf16).to_string();
        // Sanity check: if it contains printable ASCII it decoded correctly
        if decoded.chars().any(|c| c.is_ascii_alphabetic()) {
            return decoded;
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

// ── Server health ─────────────────────────────────────────────────────────────

async fn wait_for_server() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if client
            .get(HEALTH_URL)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

// ── Sidecar ───────────────────────────────────────────────────────────────────

fn find_agentop(app: &AppHandle) -> Option<PathBuf> {
    // NSIS places agentop.exe in the same directory as the main exe (resource_dir).
    // Tauri sidecar convention (binaries/ + target triple) is a fallback.
    let res = app.path().resource_dir().ok()?;
    log_error(&format!("resource_dir: {}", res.display()));

    let candidates = [
        res.join("agentop.exe"),
        res.join("binaries").join("agentop-x86_64-pc-windows-msvc.exe"),
        res.join("binaries").join("agentop.exe"),
    ];
    for c in &candidates {
        log_error(&format!("candidate: {} exists={}", c.display(), c.exists()));
        if c.exists() {
            return Some(c.clone());
        }
    }
    None
}

fn spawn_sidecar(
    app: &AppHandle,
    child_handle: &Arc<Mutex<Option<Child>>>,
    claude_dir: &str,
) -> Result<(), String> {
    let binary = find_agentop(app)
        .ok_or_else(|| "agentop.exe not found in install directory".to_string())?;

    log_error(&format!("spawning: {}", binary.display()));

    let mut cmd = std::process::Command::new(&binary);
    cmd.arg("server").env("CLAUDE_DIR", claude_dir);

    // Multi-harness: the other CLIs (Codex/Gemini/Copilot) live next to ~/.claude
    // in the same home directory. The selected claude_dir is "<home>/.claude", so
    // point each adapter at its sibling. Without this the server derives them from
    // the Windows HOME and never finds the user's WSL data → only Claude shows up.
    if let Some(home) = Path::new(claude_dir).parent() {
        cmd.env("CODEX_DIR", home.join(".codex"));
        cmd.env("GEMINI_DIR", home.join(".gemini"));
        cmd.env("COPILOT_DIR", home.join(".copilot"));
    }

    // Suppress the console window that would otherwise flash on Windows
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn()
        .map_err(|e| format!("failed to start server: {e}"))?;

    *child_handle.lock().unwrap() = Some(child);
    Ok(())
}

// ── Who runs the server ───────────────────────────────────────────────────────
//
// 2026-10-04 (docs/incidents/2026-10-04-server-outside-unit.md): a server started beside the WSL
// `agentop-server` systemd unit holds the data directory, the unit is refused and stays failed, and
// the machine keeps serving whatever version that copy was. So this app never starts a server of
// its own when one already answers, and for a WSL source whose distro has the unit installed it
// starts THE UNIT (through wsl.exe) and waits for it. Only a source with neither gets the sidecar.

const SERVER_UNIT: &str = "agentop-server";

/// The distro a `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…` path lives in.
fn wsl_distro_of(path: &str) -> Option<String> {
    let p = path.replace('/', "\\");
    let lower = p.to_ascii_lowercase();
    let rest = if lower.starts_with("\\\\wsl.localhost\\") {
        &p["\\\\wsl.localhost\\".len()..]
    } else if lower.starts_with("\\\\wsl$\\") {
        &p["\\\\wsl$\\".len()..]
    } else {
        return None;
    };
    let distro = rest.split('\\').next().unwrap_or("");
    // The same closed alphabet the server's autostart validates a distro name against.
    if !distro.is_empty() && distro.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        Some(distro.to_string())
    } else {
        None
    }
}

#[derive(Debug, PartialEq)]
enum LaunchPlan {
    /// Something already answers on the API port — use it, start nothing.
    AlreadyServing,
    /// The source's distro has the `agentop-server` unit: start it, never a second server.
    StartWslUnit(String),
    /// No server, no unit: the bundled sidecar is the only way to get one.
    Sidecar,
}

fn plan_launch(serving: bool, distro: Option<&str>, unit_installed: bool) -> LaunchPlan {
    if serving {
        return LaunchPlan::AlreadyServing;
    }
    match distro {
        Some(d) if unit_installed => LaunchPlan::StartWslUnit(d.to_string()),
        _ => LaunchPlan::Sidecar,
    }
}

/// A `wsl.exe -d <distro> --exec /bin/sh -c <script>` that runs hidden. `--exec` skips the login
/// shell, so the user bus is pointed at explicitly — without XDG_RUNTIME_DIR `systemctl --user`
/// cannot reach the manager at all.
fn wsl_sh(distro: &str, script: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("wsl.exe");
    let full = format!(
        "export XDG_RUNTIME_DIR=\"${{XDG_RUNTIME_DIR:-/run/user/$(id -u)}}\"; {script}"
    );
    cmd.args(["-d", distro, "--exec", "/bin/sh", "-c", &full]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

fn wsl_unit_installed(distro: &str) -> bool {
    wsl_sh(distro, &format!("test -f \"$HOME/.config/systemd/user/{SERVER_UNIT}.service\""))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `reset-failed` first: a unit refused while a stray held the data dir stays failed otherwise.
/// The unit's own start takes back a stray that is provably its own server (`server-ownership.ts`).
fn start_wsl_unit(distro: &str) -> Result<(), String> {
    let out = wsl_sh(
        distro,
        &format!("systemctl --user reset-failed {SERVER_UNIT} 2>/dev/null; systemctl --user start {SERVER_UNIT}"),
    )
    .output()
    .map_err(|e| format!("could not run wsl.exe: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "systemctl --user start {SERVER_UNIT} failed in {distro}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

async fn server_answers() -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(800)).build() else {
        return false;
    };
    client.get(HEALTH_URL).send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

/// Bring a server up the one right way for this source, then navigate once it answers.
async fn launch(
    app: AppHandle,
    child_handle: Arc<Mutex<Option<Child>>>,
    claude_dir: String,
    config_path: PathBuf,
) -> Result<(), String> {
    let serving = server_answers().await;
    let distro = wsl_distro_of(&claude_dir);
    let unit = match (&distro, serving) {
        (Some(d), false) => wsl_unit_installed(d),
        _ => false,
    };
    let plan = plan_launch(serving, distro.as_deref(), unit);
    log_error(&format!("launch plan: {plan:?}"));
    match plan {
        LaunchPlan::AlreadyServing => {}
        LaunchPlan::StartWslUnit(d) => start_wsl_unit(&d)?,
        LaunchPlan::Sidecar => spawn_sidecar(&app, &child_handle, &claude_dir)?,
    }
    navigate_after_ready(app, config_path);
    Ok(())
}

fn navigate_after_ready(app: AppHandle, config_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let ready = wait_for_server().await;
        if let Some(win) = app.get_webview_window("main") {
            if ready {
                let _ = win.navigate(DASHBOARD_URL.parse().unwrap());
            } else {
                // Delete config so next launch shows onboarding again
                let _ = std::fs::remove_file(&config_path);
                let sources = serde_json::to_string(&detect_sources()).unwrap_or_default();
                let _ = win.eval(&format!(
                    "window.__agentisticsError = 'Server failed to start. Check the selected path and try again.';
                     window.__agentisticsSources = {sources};
                     if (typeof buildSources === 'function') {{
                         buildSources(window.__agentisticsSources);
                         document.getElementById('error').textContent = window.__agentisticsError;
                         document.getElementById('error').style.display = 'block';
                         show('onboarding');
                     }}"
                ));
            }
        }
    });
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SetupState {
    configured: bool,
    claude_dir: Option<String>,
    sources: Vec<ClaudeSource>,
}

struct AppState {
    child_handle: Arc<Mutex<Option<Child>>>,
    config_path: PathBuf,
}

#[tauri::command]
fn get_setup_state(state: State<AppState>) -> SetupState {
    let config = read_config(&state.config_path);
    let configured = config.is_some();
    SetupState {
        claude_dir: config.as_ref().map(|c| c.claude_dir.clone()),
        sources: if configured { vec![] } else { detect_sources() },
        configured,
    }
}

#[tauri::command]
async fn launch_with_config(
    claude_dir: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    launch(app, state.child_handle.clone(), claude_dir.clone(), state.config_path.clone()).await?;
    write_config(&state.config_path, &Config { claude_dir })?;
    Ok(())
}

#[tauri::command]
fn reset_config(state: State<AppState>) -> Result<(), String> {
    if state.config_path.exists() {
        std::fs::remove_file(&state.config_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Forget the saved data source and restart, so the onboarding source picker
/// (Windows / WSL) shows again. Invoked from the dashboard's Settings.
#[tauri::command]
fn change_source(state: State<AppState>, app: AppHandle) {
    let _ = std::fs::remove_file(&state.config_path);
    app.restart();
}

// ── Auto-update ───────────────────────────────────────────────────────────────

async fn check_for_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log_error(&format!("updater init failed: {e}"));
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            log_error("update check: already on the latest version");
            return;
        }
        Err(e) => {
            log_error(&format!("update check failed: {e}"));
            return;
        }
    };

    let version = update.version.clone();
    log_error(&format!("update available: {} (current {})", version, update.current_version));
    let msg = format!(
        "Agentistics {} is available (you have {}).\n\nInstall now?",
        version,
        update.current_version
    );

    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_ICONINFORMATION, MB_YESNO,
        };

        let title_w: Vec<u16> = OsStr::new("Agentistics — Update Available")
            .encode_wide().chain(Some(0)).collect();
        let msg_w: Vec<u16> = OsStr::new(&msg).encode_wide().chain(Some(0)).collect();

        let result = unsafe {
            MessageBoxW(
                HWND::default(),
                windows::core::PCWSTR(msg_w.as_ptr()),
                windows::core::PCWSTR(title_w.as_ptr()),
                MB_ICONINFORMATION | MB_YESNO,
            )
        };

        if result == IDYES {
            let _ = update
                .download_and_install(|_, _| {}, || {})
                .await;
            app.restart();
        }
    }
    #[cfg(not(windows))]
    let _ = (update, msg);
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    install_panic_hook();

    let child_handle: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_exit = child_handle.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            child_handle: child_handle.clone(),
            config_path: config_path(),
        })
        .invoke_handler(tauri::generate_handler![
            get_setup_state,
            launch_with_config,
            reset_config,
            change_source,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Check for updates in background
            let update_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                check_for_update(update_handle).await;
            });

            // If already configured, start the sidecar right away.
            let cfg_path = config_path();
            if let Some(config) = read_config(&cfg_path) {
                let child_handle = child_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = launch(handle, child_handle, config.claude_dir, cfg_path.clone()).await {
                        log_error(&format!("launch failed: {e}"));
                        // Clear config so onboarding shows on next launch
                        let _ = std::fs::remove_file(&cfg_path);
                    }
                });
            }
            // Otherwise the JS onboarding calls launch_with_config.
            Ok(())
        })
        .on_window_event(move |_win, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = child_exit.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            let msg = format!("Agentistics failed to start: {e}");
            log_error(&msg);
            show_error_dialog("Agentistics — Fatal Error", &msg);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distro_is_read_off_both_unc_spellings() {
        assert_eq!(wsl_distro_of("\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\.claude").as_deref(), Some("Ubuntu-22.04"));
        assert_eq!(wsl_distro_of("\\\\wsl$\\Debian\\root\\.claude").as_deref(), Some("Debian"));
        assert_eq!(wsl_distro_of("//wsl.localhost/Ubuntu/home/u/.claude").as_deref(), Some("Ubuntu"));
        assert_eq!(wsl_distro_of("C:\\Users\\u\\.claude"), None);
        assert_eq!(wsl_distro_of("\\\\wsl.localhost\\bad;name\\x"), None);
    }

    #[test]
    fn a_server_that_answers_is_used_never_duplicated() {
        assert_eq!(plan_launch(true, Some("Ubuntu"), true), LaunchPlan::AlreadyServing);
        assert_eq!(plan_launch(true, None, false), LaunchPlan::AlreadyServing);
    }

    #[test]
    fn a_wsl_source_with_the_unit_starts_the_unit() {
        assert_eq!(plan_launch(false, Some("Ubuntu"), true), LaunchPlan::StartWslUnit("Ubuntu".into()));
    }

    #[test]
    fn the_sidecar_only_without_server_or_unit() {
        assert_eq!(plan_launch(false, Some("Ubuntu"), false), LaunchPlan::Sidecar);
        assert_eq!(plan_launch(false, None, false), LaunchPlan::Sidecar);
    }
}
