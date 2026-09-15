use tauri::{Manager, Emitter};
use tauri::utils::config::Color;
use tauri::tray::TrayIconEvent;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use std::sync::Mutex;

mod audio_device;
mod accessibility;
mod speaker_ax;
mod soniox_transcriber;
mod dev_sessions;
mod device_monitor;
mod logger;
#[cfg(target_os = "macos")]
mod mic_cpal;
mod mic_detect;
mod permissions;
mod system_audio;
use system_audio::SystemAudioRecorder;
use system_audio::RealtimeRecorder;

/// macOS App Nap control. While recording, we hold an `NSProcessInfo` activity
/// with `UserInitiated` options so the OS does NOT throttle/nap the app when its
/// main window is backgrounded behind a fullscreen meeting — keeping the main
/// window's WebView (and its Record/Pause/Resume/Stop controls) responsive.
#[cfg(target_os = "macos")]
mod app_nap {
    use std::sync::Mutex;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // The activity token is opaque and NSProcessInfo's begin/endActivity are
    // documented thread-safe, so it's safe to hold across threads.
    unsafe impl Send for Activity {}

    static CURRENT: Mutex<Option<Activity>> = Mutex::new(None);

    pub fn set_active(active: bool) {
        let mut guard = match CURRENT.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if active {
            if guard.is_none() {
                let pi = NSProcessInfo::processInfo();
                let reason = NSString::from_str("WisprNote is recording a meeting");
                let token = pi.beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &reason);
                *guard = Some(Activity(token));
            }
        } else if let Some(Activity(token)) = guard.take() {
            let pi = NSProcessInfo::processInfo();
            unsafe { pi.endActivity(&token) };
        }
    }
}

/// Hold/release the App Nap-disabling activity. Called true on record start,
/// false on stop, so the main window stays responsive while a meeting records.
#[tauri::command]
fn set_recording_active(active: bool) {
    #[cfg(target_os = "macos")]
    app_nap::set_active(active);
    #[cfg(not(target_os = "macos"))]
    let _ = active;
}

/// The OS this build is running on — "macos" | "windows" | "linux". Authoritative
/// (compile-time), so the UI can reliably inset its header below the macOS traffic
/// lights without depending on the webview's userAgent.
#[tauri::command]
fn get_os_platform() -> String {
    std::env::consts::OS.to_string()
}


// Global state for the audio recorder
struct AppState {
    recorder: Mutex<SystemAudioRecorder>,
    realtime_recorder: Mutex<RealtimeRecorder>,
}

/// Check if system audio recording is available on this platform
#[tauri::command]
fn is_system_audio_available() -> bool {
    cfg!(target_os = "macos")
}

/// Start recording system + mic audio
#[tauri::command]
fn start_system_audio(
    state: tauri::State<AppState>,
    detect: tauri::State<mic_detect::MicDetectState>,
) -> Result<(), String> {
    // Pause mic detection while we record so our own capture can't re-trigger an
    // "are you in a meeting?" prompt. Done here in Rust (not via a JS round-trip)
    // so it's immediate even when the main window is backgrounded/throttled.
    detect.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    recorder.start()
}

/// Stop recording, write the WAV to a temp file on disk, and return its PATH.
///
/// Previously this base64-encoded the entire (up to ~600 MB) WAV and shipped it
/// across the Tauri IPC bridge as one giant string — a ~+33% size blow-up plus
/// several full in-memory copies (Rust Vec → base64 String → JS string → bytes →
/// Blob). For long recordings that meant multi-GB RAM spikes and slow handoff.
///
/// Now the bytes stay in Rust and are written straight to a file in the app
/// cache dir; JS receives only the short path and reads the file on demand. The
/// file is deleted via `delete_recording_file` once the batch completes.
#[tauri::command]
fn stop_system_audio(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    detect: tauri::State<mic_detect::MicDetectState>,
) -> Result<String, String> {
    detect.paused.store(false, std::sync::atomic::Ordering::SeqCst);
    let wav_data = {
        let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
        recorder.stop()?
    };

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    // Unique filename (nanos since epoch) — no extra uuid dependency needed.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("rec_{stamp}.wav"));
    std::fs::write(&path, &wav_data).map_err(|e| format!("write: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

/// Delete a recording temp file written by `stop_system_audio`. Best-effort; a
/// missing file is not an error (it may have already been cleaned up).
#[tauri::command]
fn delete_recording_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Startup safety-net: delete recording temp files older than `max_age_secs`
/// (default 24h) from the recordings cache dir. Catches files orphaned by a hard
/// crash between recording and processing. Returns the number removed.
#[tauri::command]
fn sweep_old_recordings(app: tauri::AppHandle, max_age_secs: Option<u64>) -> Result<u32, String> {
    let max_age = std::time::Duration::from_secs(max_age_secs.unwrap_or(24 * 60 * 60));
    let dir = match app.path().app_cache_dir() {
        Ok(d) => d.join("recordings"),
        Err(_) => return Ok(0),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(0), // dir doesn't exist yet → nothing to sweep
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        let too_old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|mtime| now.duration_since(mtime).map(|age| age > max_age).unwrap_or(false))
            .unwrap_or(false);
        if too_old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Check if currently recording
#[tauri::command]
fn is_system_audio_recording(state: tauri::State<AppState>) -> bool {
    if let Ok(recorder) = state.recorder.lock() {
        recorder.is_recording()
    } else {
        false
    }
}

/// Get current audio size in bytes
#[tauri::command]
fn get_system_audio_size(state: tauri::State<AppState>) -> usize {
    if let Ok(recorder) = state.recorder.lock() {
        recorder.get_audio_size()
    } else {
        0
    }
}

/// Start realtime recording with integrated Soniox transcription
#[tauri::command]
fn start_realtime_audio(
    api_key: String,
    keyterms: Option<Vec<String>>,
    language: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
    detect: tauri::State<mic_detect::MicDetectState>,
) -> Result<(), String> {
    detect.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.start(api_key, keyterms, language, app_handle)
}

/// Stop realtime recording and return the full transcript
#[tauri::command]
fn stop_realtime_audio(
    state: tauri::State<AppState>,
    detect: tauri::State<mic_detect::MicDetectState>,
) -> Result<String, String> {
    detect.paused.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.stop()
}

/// Pause realtime recording: release the mic but keep the WebSocket warm. Instant —
/// no teardown/rebuild of the streaming pipeline.
#[tauri::command]
fn pause_realtime_audio(state: tauri::State<AppState>) -> Result<(), String> {
    let recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.pause()
}

/// Resume realtime recording: rebuild only the mic capture; the warm socket continues.
#[tauri::command]
fn resume_realtime_audio(state: tauri::State<AppState>) -> Result<(), String> {
    let recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.resume()
}

/// Check if realtime recording is active
#[tauri::command]
fn is_realtime_recording(state: tauri::State<AppState>) -> bool {
    if let Ok(recorder) = state.realtime_recorder.lock() {
        recorder.is_recording()
    } else {
        false
    }
}

// ─── Audio Device Commands ───────────────────────────────────────────────────

#[tauri::command]
fn list_audio_devices() -> Result<Vec<audio_device::AudioDevice>, String> {
    audio_device::list_all_devices()
}

#[tauri::command]
fn get_default_input() -> Result<Option<audio_device::AudioDevice>, String> {
    audio_device::get_default_input_device()
}

#[tauri::command]
fn get_default_output() -> Result<Option<audio_device::AudioDevice>, String> {
    audio_device::get_default_output_device()
}

/// Set macOS default input device (CoreAudio UID). Recording follows this device, including
/// Bluetooth and USB headsets, matching anarlog-style audio settings.
#[tauri::command]
fn set_default_input_device(device_id: String) -> Result<(), String> {
    audio_device::set_default_input_device(&device_id)
}

/// Set macOS default output device (CoreAudio UID).
#[tauri::command]
fn set_default_output_device(device_id: String) -> Result<(), String> {
    audio_device::set_default_output_device(&device_id)
}

// ─── Speaker-name capture (Accessibility) ────────────────────────────────────
//
// Diarisation says "voice #2"; only the meeting application knows that voice #2 is
// Ada. These commands drive the accessibility read of its participant tiles.

/// Is Accessibility permission already granted?
#[tauri::command]
fn accessibility_is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    { accessibility::is_trusted() }
    #[cfg(not(target_os = "macos"))]
    { false }
}

/// Show the system Accessibility prompt. macOS presents it only ONCE per app, so a
/// false return after a previous denial means "send the user to System Settings",
/// not "ask again".
#[tauri::command]
fn accessibility_request_trust() -> bool {
    #[cfg(target_os = "macos")]
    { accessibility::request_trust() }
    #[cfg(not(target_os = "macos"))]
    { false }
}

/// Open System Settings at the Accessibility pane (for the already-denied case).
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { Ok(()) }
}

/// Begin watching whichever meeting app is actually in a call.
///
/// Detection happens HERE rather than being handed a bundle id, because the
/// microphone-holder signal that drives the meeting prompt is about deciding
/// whether to prompt — it is unset when the user starts recording by hand, or once
/// the prompt for that app has been dismissed. Depending on it made capture
/// silently do nothing for exactly the cases that matter.
///
/// Returns the platform bound. `"unsupported"` means no app is in a readable call
/// (or the one in the call is FaceTime/Webex/Discord, which publish no participant
/// grid) — the meeting is still recorded and diarised, speakers just stay
/// "Speaker N" until renamed.
#[tauri::command]
fn start_speaker_capture(
    app: tauri::AppHandle,
    marker_classes: Option<Vec<String>>,
    tile_root_classes: Option<Vec<String>>,
    state: tauri::State<speaker_ax::SpeakerPollState>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if !accessibility::is_trusted() {
            return Err("accessibility_permission_required".into());
        }
        let Some((platform, pid)) = speaker_ax::detect_platform() else {
            return Ok("unsupported".into());
        };

        // Remote-overridable selectors: Meet keys on obfuscated build classes that
        // Google renames without notice, so a breakage has to be fixable by config
        // rather than by shipping a new app.
        let mut cfg = speaker_ax::SpeakerPollConfig::defaults_for(platform);
        if let Some(m) = marker_classes { if !m.is_empty() { cfg.marker_classes = m; } }
        if let Some(t) = tile_root_classes { if !t.is_empty() { cfg.tile_root_classes = t; } }

        state.start(app, pid, platform, cfg);
        Ok(serde_json::to_value(platform).ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "unsupported".into()))
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, marker_classes, tile_root_classes, state); Ok("unsupported".into()) }
}

/// What the accessibility read currently sees — for diagnosing a live meeting.
#[tauri::command]
fn speaker_capture_probe() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        let trusted = accessibility::is_trusted();
        let detected = speaker_ax::detect_platform();
        let (platform, pid) = match detected {
            Some((p, pid)) => (serde_json::to_value(p).unwrap_or_default(), Some(pid)),
            None => (serde_json::Value::String("unsupported".into()), None),
        };
        let reading = pid.and_then(|pid| {
            let p = detected.map(|(p, _)| p)?;
            speaker_ax::read_once(pid, p, &speaker_ax::SpeakerPollConfig::defaults_for(p))
        });
        serde_json::json!({
            "accessibility_trusted": trusted,
            "platform": platform,
            "pid": pid,
            "reading": reading.map(|r| serde_json::json!({
                "speaker_name": r.speaker_name,
                "visible_names": r.visible_names,
                "attribution_state": r.attribution_state,
            })),
        })
    }
    #[cfg(not(target_os = "macos"))]
    { serde_json::json!({ "accessibility_trusted": false, "platform": "unsupported" }) }
}

#[tauri::command]
fn stop_speaker_capture(state: tauri::State<speaker_ax::SpeakerPollState>) {
    #[cfg(target_os = "macos")]
    { state.stop(); }
    #[cfg(not(target_os = "macos"))]
    { let _ = state; }
}

// ─── Permission Commands ─────────────────────────────────────────────────────

#[tauri::command]
fn check_permissions() -> permissions::PermissionStatus {
    #[cfg(target_os = "macos")]
    { permissions::macos::check_permissions() }
    #[cfg(not(target_os = "macos"))]
    { permissions::stub::check_permissions() }
}

#[tauri::command]
async fn request_microphone_permission() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        { permissions::macos::request_microphone() }
        #[cfg(not(target_os = "macos"))]
        { permissions::stub::request_microphone() }
    }).await.map_err(|e| format!("{}", e))?
}

#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { permissions::macos::open_screen_recording_settings() }
    #[cfg(not(target_os = "macos"))]
    { permissions::stub::open_screen_recording_settings() }
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { permissions::macos::open_microphone_settings() }
    #[cfg(not(target_os = "macos"))]
    { permissions::stub::open_microphone_settings() }
}

// ─── Meeting Detection Commands ──────────────────────────────────────────────

/// Pause/resume microphone-usage detection. The frontend pauses it while we are
/// recording so our own capture never triggers an "are you in a meeting?" prompt.
#[tauri::command]
fn set_detection_paused(paused: bool, state: tauri::State<mic_detect::MicDetectState>) {
    state
        .paused
        .store(paused, std::sync::atomic::Ordering::SeqCst);
}

/// Enable/disable meeting detection. The frontend enables it once the user is
/// signed in (it's off by default so we never prompt on the auth screen).
#[tauri::command]
fn set_detection_enabled(enabled: bool, state: tauri::State<mic_detect::MicDetectState>) {
    state
        .enabled
        .store(enabled, std::sync::atomic::Ordering::SeqCst);
}

/// The most recent mic-detection, so the meeting-prompt overlay window can
/// render the right app name immediately on open without racing the event.
#[tauri::command]
fn get_pending_meeting(
    state: tauri::State<mic_detect::MicDetectState>,
) -> Option<mic_detect::MicDetectedInfo> {
    state.last_detected.lock().ok().and_then(|g| g.clone())
}

// ─── Floating Recording Indicator Window ─────────────────────────────────────

const RECORDING_INDICATOR_LABEL: &str = "recording-indicator";

/// Show or hide the small always-on-top recording indicator overlay. The window
/// is created lazily on first show and reused afterwards. It loads the same web
/// bundle with a `?window=recording-indicator` query so the frontend renders the
/// indicator UI instead of the main app.
#[tauri::command]
fn set_recording_indicator(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if app.get_webview_window(RECORDING_INDICATOR_LABEL).is_none() {
        // Normally pre-created at startup; build as a fallback if missing.
        build_recording_indicator_window(&app, false)?;
        #[cfg(target_os = "macos")]
        configure_overlay_panel(&app, RECORDING_INDICATOR_LABEL);
    }
    if let Some(win) = app.get_webview_window(RECORDING_INDICATOR_LABEL) {
        if visible {
            let _ = win.set_visible_on_all_workspaces(true);
            let _ = win.set_always_on_top(true);
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
        mark_overlay_visible(RECORDING_INDICATOR_LABEL, visible);
    }
    Ok(())
}

/// Build the floating recording-indicator overlay (optionally hidden). Pre-built
/// hidden at startup so it can be converted to an NSPanel on the main thread and
/// shown instantly later.
fn build_recording_indicator_window(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    // Window is sized for the EXPANDED hover panel; the capsule sits at the right
    // edge and the transcript/chat panel grows left into the transparent area.
    // The passthrough poll keeps only the reported hit-rect interactive, so the
    // large transparent region stays click-through. Right-edge, centered.
    let width = 360.0_f64;
    let height = 200.0_f64;

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        RECORDING_INDICATOR_LABEL,
        tauri::WebviewUrl::App("overlay.html?window=recording-indicator".into()),
    )
    .title("Recording")
    .inner_size(width, height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(visible);

    // Pin to the RIGHT edge, vertically centered (matching anarlog's placement).
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let logical_width = monitor.size().width as f64 / scale;
        let logical_height = monitor.size().height as f64 / scale;
        let x = (logical_width - width - 12.0).max(0.0);
        let y = ((logical_height - height) / 2.0).max(0.0);
        builder = builder.position(x, y);
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert an overlay window into a NON-ACTIVATING NSPanel (macOS).
///
/// This is the load-bearing fix (matching anarlog/Hyprnote's native panels): a
/// plain Tauri window is a regular `NSWindow` that ACTIVATES when clicked — so
/// its buttons need a focus-stealing first click, and clicking it deactivates
/// (and throttles) the main window. A non-activating `NSPanel`:
///   • delivers clicks to its buttons on the FIRST click, and
///   • never becomes key / never steals focus from the app you're in.
/// It also floats over fullscreen on every Space.
#[cfg(target_os = "macos")]
fn configure_overlay_panel(app: &tauri::AppHandle, label: &str) {
    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use tauri_nspanel::WebviewWindowExt;

    let Some(window) = app.get_webview_window(label) else { return };
    let panel = match window.to_panel() {
        Ok(p) => p,
        Err(_) => return,
    };
    panel.set_style_mask(1 << 7); // NSWindowStyleMaskNonactivatingPanel
    panel.set_level(3); // NSFloatingWindowLevel
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary,
    );
    panel.set_becomes_key_only_if_needed(true); // don't grab key focus on click
    panel.set_hides_on_deactivate(false);
    panel.set_released_when_closed(false);

    // Start click-through: the panel passes ALL mouse events to whatever is
    // beneath it; the passthrough poll flips it interactive only while the cursor
    // is over the visible pill. Without this baseline the panel blocks its rect.
    let _ = window.set_ignore_cursor_events(true);

    // Exclude the overlay from screen capture — it's visible to the user but does
    // NOT appear in screen recordings, screen shares, or screenshots
    // (NSWindowSharingNone = 0). Same as anarlog's `panel.sharingType = .none`.
    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            let ns_window = ptr as *mut objc2::runtime::AnyObject;
            unsafe {
                let _: () = objc2::msg_send![ns_window, setSharingType: 0usize];
            }
        }
    }
}

const MEETING_PROMPT_LABEL: &str = "meeting-prompt";

// Cheap, lock-free visibility flags for the two overlays. The passthrough poll
// reads these instead of calling `is_visible()` (a main-thread hop) every tick,
// so a hidden overlay costs the main thread NOTHING — the whole reason the main
// window's pause/stop clicks stopped lagging.
static INDICATOR_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PROMPT_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn overlay_visible_flag(label: &str) -> Option<&'static std::sync::atomic::AtomicBool> {
    match label {
        RECORDING_INDICATOR_LABEL => Some(&INDICATOR_VISIBLE),
        MEETING_PROMPT_LABEL => Some(&PROMPT_VISIBLE),
        _ => None,
    }
}

/// Record an overlay's shown/hidden state for the passthrough poll. Called from
/// every show/hide path (including the native detector thread in `mic_detect`).
pub(crate) fn mark_overlay_visible(label: &str, visible: bool) {
    if let Some(flag) = overlay_visible_flag(label) {
        flag.store(visible, std::sync::atomic::Ordering::SeqCst);
    }
}

// Optional "fake window bounds" (anarlog's technique): the frontend reports the
// rectangle of the actual visible content (in window-logical px, relative to the
// window's top-left). The passthrough then makes the window interactive ONLY
// over that rectangle instead of its whole transparent rect — so the empty space
// around a card/pill stays click-through and never blocks the screen beneath it.
static INDICATOR_HIT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
static PROMPT_HIT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

fn overlay_hit_mutex(label: &str) -> Option<&'static Mutex<Option<(f64, f64, f64, f64)>>> {
    match label {
        RECORDING_INDICATOR_LABEL => Some(&INDICATOR_HIT),
        MEETING_PROMPT_LABEL => Some(&PROMPT_HIT),
        _ => None,
    }
}

/// Report the interactive content rectangle (window-logical px) for an overlay.
#[tauri::command]
fn set_overlay_hit_bounds(label: String, x: f64, y: f64, width: f64, height: f64) {
    if let Some(m) = overlay_hit_mutex(&label) {
        if let Ok(mut g) = m.lock() {
            *g = Some((x, y, width, height));
        }
    }
}

/// Clear an overlay's reported bounds → it falls back to whole-window hit-testing.
#[tauri::command]
fn clear_overlay_hit_bounds(label: String) {
    if let Some(m) = overlay_hit_mutex(&label) {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

/// Keep a transparent overlay click-through EXCEPT when the cursor is over it.
///
/// A WKWebView captures every click in its window rect (it can't hit-test the
/// pill shape the way anarlog's native panel does), so without this the overlay
/// traps all mouse input under it and the user "loses access to the screen".
///
/// This poll (ported from Hyprnote's overlay plugin) keeps the window
/// `ignore_cursor_events(true)` — clicks pass straight through — and flips it to
/// interactive ONLY while the cursor is within the window's bounds. It is
/// FAIL-SAFE: if the cursor position can't be read for any reason, it defaults
/// to click-through, so the screen is never blocked.
fn spawn_overlay_passthrough(app: tauri::AppHandle, label: &'static str) {
    let Some(visible_flag) = overlay_visible_flag(label) else { return };
    std::thread::spawn(move || {
        // `None` = real window state unknown → force-apply on the next iteration.
        // (anarlog's bug-free version calls `set_ignore_cursor_events(true)` ONCE
        // before its loop so the tracker matches reality; we replicate that by
        // forcing the baseline whenever the window (re)appears.)
        let mut last_ignore: Option<bool> = None;
        let mut was_visible = false;
        // Cached window rect (physical px): x0, y0, x1, y1. The overlay sits at a
        // fixed spot (only the user dragging the pill moves it), so we DON'T query
        // its position/size from the main thread every tick — we cache it and
        // refresh on the show edge + every ~750ms. Only the cursor is polled live.
        // Cached window geometry (physical px): position x/y, size w/h, scale.
        // The overlay sits at a fixed spot (only dragging moves it), so we DON'T
        // query this from the main thread every tick — cache + refresh on the show
        // edge, every ~750ms, and while the cursor is over the content (drag).
        let mut geo: Option<(f64, f64, f64, f64, f64)> = None;
        let mut geo_age = 0u32;
        // Whether the cursor was over the content last tick (i.e. the user is
        // interacting — possibly dragging) and how many consecutive ticks it has
        // been outside. Both exist to keep a native window drag from being
        // cancelled by us flipping click-through back on mid-drag.
        let mut was_inside = false;
        let mut outside_streak = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50)); // 20 Hz (anarlog's rate)

            // Cheap atomic read — no main-thread hop. A hidden overlay costs the
            // main thread NOTHING here, so it never competes with the main window's
            // IPC (the source of the pause/stop lag).
            if !visible_flag.load(std::sync::atomic::Ordering::SeqCst) {
                was_visible = false;
                last_ignore = None; // re-sync (force click-through) on next show
                geo = None;
                continue;
            }
            let Some(win) = app.get_webview_window(label) else { continue };

            // On the hidden→visible edge, hard-assert click-through as the baseline
            // — a freshly shown window defaults to ignore=false (it would block its
            // whole rect), so this is the load-bearing line that frees the screen.
            if !was_visible {
                let _ = win.set_ignore_cursor_events(true);
                last_ignore = Some(true);
                was_visible = true;
                geo = None; // force a geometry refresh below
            }

            // Refresh the cached geometry on the edge, ~every 750ms, AND every
            // tick while the cursor is over the content — the last case lets it
            // follow the window during a user DRAG so the hit-test keeps matching.
            if geo.is_none() || geo_age >= 15 || was_inside {
                geo = (|| -> Option<(f64, f64, f64, f64, f64)> {
                    let pos = win.outer_position().ok()?;
                    let size = win.outer_size().ok()?;
                    let scale = win.scale_factor().ok()?;
                    Some((pos.x as f64, pos.y as f64, size.width as f64, size.height as f64, scale))
                })();
                geo_age = 0;
            } else {
                geo_age += 1;
            }

            // Interactive hit rectangle (physical px). If the frontend reported
            // content bounds (window-logical px), use ONLY that rect — so the
            // transparent area around the card/pill stays click-through. Otherwise
            // fall back to the whole window.
            let reported = overlay_hit_mutex(label).and_then(|m| m.lock().ok().and_then(|g| *g));
            let hit = geo.map(|(px, py, sw, sh, scale)| match reported {
                Some((bx, by, bw, bh)) => {
                    let x0 = px + bx * scale;
                    let y0 = py + by * scale;
                    (x0, y0, x0 + bw * scale, y0 + bh * scale)
                }
                None => (px, py, px + sw, py + sh),
            });

            // Only the cursor is polled live each tick. Fail-safe → click-through.
            let raw_inside = match (hit, win.cursor_position().ok()) {
                (Some((x0, y0, x1, y1)), Some(cur)) => {
                    cur.x >= x0 && cur.x <= x1 && cur.y >= y0 && cur.y <= y1
                }
                _ => false,
            };
            // Hysteresis: stay interactive for a few ticks after the cursor leaves
            // so a native window drag — during which the cursor can momentarily
            // sit just off the (moving) rect — isn't cancelled by flipping
            // click-through back on mid-drag.
            if raw_inside {
                outside_streak = 0;
            } else {
                outside_streak = outside_streak.saturating_add(1);
            }
            was_inside = raw_inside;
            let inside = raw_inside || outside_streak < 3;
            let ignore = !inside;
            if last_ignore != Some(ignore) {
                let _ = win.set_ignore_cursor_events(ignore);
                last_ignore = Some(ignore);
            }
        }
    });
}

/// Build the meeting-prompt overlay window (optionally hidden). Pre-created
/// hidden at startup so showing it later is instant — the slow part (spinning
/// up the webview + loading the bundle) happens once, off the critical path.
fn build_meeting_prompt_window(
    app: &tauri::AppHandle,
    visible: bool,
) -> Result<(), String> {
    // Sized so the protruding ✕ button (top-left), the compact card, and the
    // full chevron dropdown (3 rows) all fit inside the window bounds without
    // being clipped. The window is transparent and — thanks to the reported hit
    // bounds — click-through everywhere EXCEPT over the card itself, so its size
    // no longer blocks the screen beneath.
    let width = 384.0_f64;
    let height = 220.0_f64;

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        MEETING_PROMPT_LABEL,
        tauri::WebviewUrl::App("overlay.html?window=meeting-prompt".into()),
    )
    .title("Meeting detected")
    .inner_size(width, height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    // Join all spaces + full-screen aux so the prompt appears OVER a fullscreen
    // meeting app (Zoom/Teams/Meet) — without this it hides behind the call.
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(visible);

    // Top-RIGHT of the primary monitor (logical coordinates), just under the
    // macOS menu bar — exactly where Granola/anarlog pops its notification. The
    // card itself is right-aligned inside the window and slides in right→left.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let logical_width = monitor.size().width as f64 / scale;
        let x = (logical_width - width - 12.0).max(0.0);
        let y = 16.0_f64;
        builder = builder.position(x, y);
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Show or hide the always-on-top "Are you in a meeting?" prompt overlay.
/// Reuses the pre-created window when present (instant show), matching
/// anarlog's native notification that appears the moment a meeting app grabs
/// the mic.
#[tauri::command]
fn set_meeting_prompt(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MEETING_PROMPT_LABEL) {
        if visible {
            let _ = win.set_visible_on_all_workspaces(true);
            let _ = win.set_always_on_top(true);
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
        mark_overlay_visible(MEETING_PROMPT_LABEL, visible);
        return Ok(());
    }

    if !visible {
        return Ok(());
    }

    mark_overlay_visible(MEETING_PROMPT_LABEL, true);
    build_meeting_prompt_window(&app, true)
}

/// Bring the main window to the front. Overlay windows call this right before
/// asking the main window to start/stop recording — macOS heavily throttles a
/// backgrounded WebView's timers, so foregrounding it first makes the action
/// run immediately instead of lagging behind by seconds.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // NSPanel plugin (macOS) — lets us convert the overlays into non-activating
    // panels so their buttons work on first click and never steal focus.
    #[cfg(target_os = "macos")]
    { builder = builder.plugin(tauri_nspanel::init()); }
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            recorder: Mutex::new(SystemAudioRecorder::new()),
            realtime_recorder: Mutex::new(RealtimeRecorder::new()),
        })
        .manage(mic_detect::MicDetectState::default())
        .manage(speaker_ax::SpeakerPollState::default())
        // Show the window only AFTER the webview finishes loading its content.
        // The window starts hidden (visible:false in tauri.conf.json); revealing
        // it post-paint means the user never sees a blank/black unpainted frame
        // on launch — the same technique the reference app uses for smooth
        // window transitions. The native background color (set in setup) covers
        // any sub-frame gap during later resizes.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            // Get the main window and set it up
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Wisprnote AI").ok();

            // Color the NATIVE window background from frame one. This is the real
            // fix for the macOS black flash on minimize/maximize (tauri#14288):
            // during an OS resize the WKWebView lags a frame behind the native
            // window, and whatever the native window is backed by shows through.
            // CSS / the JS setBackgroundColor API can't fill that native gap in
            // time — only the native window color does. Dark canvas (#141414) is
            // the safe initial value; the frontend keeps it synced to the active
            // theme via window.setBackgroundColor() on mount + theme change.
            window.set_background_color(Some(Color(20, 20, 20, 255))).ok();

            // Spawn audio device monitor — emits events when mic/speaker changes.
            // Only forward actual default-device changes to the frontend.
            // DeviceListChanged is ignored because our own aggregate device
            // creation/destruction triggers it, causing a false-positive feedback loop.
            let monitor_handle = app.handle().clone();
            let (dev_tx, dev_rx) = std::sync::mpsc::channel();
            let _monitor = device_monitor::spawn_monitor(dev_tx);
            std::thread::spawn(move || {
                while let Ok(change) = dev_rx.recv() {
                    match &change {
                        device_monitor::DeviceChange::DefaultInputChanged => {
                            let _ = monitor_handle.emit("audio-device-change", "input-changed");
                        }
                        device_monitor::DeviceChange::DefaultOutputChanged => {
                            let _ = monitor_handle.emit("audio-device-change", "output-changed");
                        }
                        device_monitor::DeviceChange::DeviceListChanged => {
                            // Intentionally not forwarded — our aggregate devices trigger this
                        }
                    }
                }
            });

            // Build tray context menu
            // ONE record action. The Standard/Multi-lingual split mirrored the old
            // batch/realtime recording modes, which no longer exist — language is a
            // preference in the app, not a different way to record.
            let record_item = MenuItemBuilder::with_id("record", "Record").build(app)?;
            let stop_record_item = MenuItemBuilder::with_id("stop_record", "Stop Record").build(app)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open Wisprnote").build(app)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&record_item)
                .item(&stop_record_item)
                .item(&sep1)
                .item(&open_item)
                .item(&sep2)
                .item(&quit_item)
                .build()?;

            // Start microphone/meeting detection (macOS). Emits `mic-detected`
            // / `mic-stopped` events the frontend listens for to offer recording.
            {
                let detect_state = app.state::<mic_detect::MicDetectState>().inner().clone();
                mic_detect::spawn(app.handle().clone(), detect_state);
            }

            // Pre-create the overlay windows hidden so they pop instantly (no
            // webview spin-up) and — critically — so they can be converted to
            // non-activating NSPanels HERE on the main thread.
            let _ = build_meeting_prompt_window(app.handle(), false);
            let _ = build_recording_indicator_window(app.handle(), false);
            #[cfg(target_os = "macos")]
            {
                configure_overlay_panel(app.handle(), MEETING_PROMPT_LABEL);
                configure_overlay_panel(app.handle(), RECORDING_INDICATOR_LABEL);
            }
            // Keep the overlays click-through except when the cursor is over them,
            // so they never trap mouse input / block the rest of the screen.
            spawn_overlay_passthrough(app.handle().clone(), MEETING_PROMPT_LABEL);
            spawn_overlay_passthrough(app.handle().clone(), RECORDING_INDICATOR_LABEL);

            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.set_menu(Some(menu)).ok();
                tray.set_show_menu_on_left_click(true).ok();

                // Handle menu item clicks
                let win2 = window.clone();
                let app_handle = app.handle().clone();
                tray.on_menu_event(move |_tray, event| {
                    match event.id().as_ref() {
                        "open" => {
                            let _ = win2.show();
                            let _ = win2.set_focus();
                        }
                        "record" => {
                            let _ = win2.show();
                            let _ = win2.set_focus();
                            let _ = win2.emit("tray-record", "start");
                        }
                        "stop_record" => {
                            let _ = win2.emit("tray-record", "stop");
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            accessibility_is_trusted,
            accessibility_request_trust,
            open_accessibility_settings,
            start_speaker_capture,
            speaker_capture_probe,
            stop_speaker_capture,
            is_system_audio_available,
            start_system_audio,
            stop_system_audio,
            delete_recording_file,
            sweep_old_recordings,
            is_system_audio_recording,
            get_system_audio_size,
            start_realtime_audio,
            stop_realtime_audio,
            pause_realtime_audio,
            resume_realtime_audio,
            is_realtime_recording,
            list_audio_devices,
            get_default_input,
            get_default_output,
            set_default_input_device,
            set_default_output_device,
            check_permissions,
            request_microphone_permission,
            open_screen_recording_settings,
            open_microphone_settings,
            set_detection_paused,
            set_detection_enabled,
            get_pending_meeting,
            set_recording_indicator,
            set_meeting_prompt,
            set_overlay_hit_bounds,
            clear_overlay_hit_bounds,
            focus_main_window,
            set_recording_active,
            get_os_platform,
            dev_sessions::scan_dev_sessions,
            dev_sessions::list_dev_projects,
            logger::write_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wisprnote AI");
}
