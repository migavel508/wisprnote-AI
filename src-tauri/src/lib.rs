use tauri::{Manager, Emitter};
use tauri::utils::config::Color;
use tauri::tray::TrayIconEvent;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use std::sync::Mutex;

mod audio_device;
mod deepgram_transcriber;
mod device_monitor;
mod logger;
#[cfg(target_os = "macos")]
mod mic_cpal;
mod permissions;
mod system_audio;
use system_audio::SystemAudioRecorder;
use system_audio::RealtimeRecorder;

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
fn start_system_audio(state: tauri::State<AppState>) -> Result<(), String> {
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
) -> Result<String, String> {
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

/// Start realtime recording with integrated Deepgram transcription
#[tauri::command]
fn start_realtime_audio(
    api_key: String,
    keyterms: Option<Vec<String>>,
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.start(api_key, keyterms, app_handle)
}

/// Stop realtime recording and return the full transcript
#[tauri::command]
fn stop_realtime_audio(state: tauri::State<AppState>) -> Result<String, String> {
    let mut recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.stop()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            recorder: Mutex::new(SystemAudioRecorder::new()),
            realtime_recorder: Mutex::new(RealtimeRecorder::new()),
        })
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
            let record_standard = MenuItemBuilder::with_id("record_standard", "Record (Standard)").build(app)?;
            let record_multilingual = MenuItemBuilder::with_id("record_multilingual", "Record (Multi-lingual)").build(app)?;
            let stop_record_item = MenuItemBuilder::with_id("stop_record", "Stop Record").build(app)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open Wisprnote").build(app)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&record_standard)
                .item(&record_multilingual)
                .item(&stop_record_item)
                .item(&sep1)
                .item(&open_item)
                .item(&sep2)
                .item(&quit_item)
                .build()?;

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
                        "record_standard" => {
                            let _ = win2.show();
                            let _ = win2.set_focus();
                            let _ = win2.emit("tray-record", "start-realtime");
                        }
                        "record_multilingual" => {
                            let _ = win2.show();
                            let _ = win2.set_focus();
                            let _ = win2.emit("tray-record", "start-batch");
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
            is_system_audio_available,
            start_system_audio,
            stop_system_audio,
            delete_recording_file,
            sweep_old_recordings,
            is_system_audio_recording,
            get_system_audio_size,
            start_realtime_audio,
            stop_realtime_audio,
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
            logger::write_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wisprnote AI");
}
