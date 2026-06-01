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

/// Stop recording and return WAV data as base64
#[tauri::command]
fn stop_system_audio(state: tauri::State<AppState>) -> Result<String, String> {
    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    let wav_data = recorder.stop()?;

    // Encode as base64 for easy transfer to frontend
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    Ok(STANDARD.encode(&wav_data))
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
        .manage(AppState {
            recorder: Mutex::new(SystemAudioRecorder::new()),
            realtime_recorder: Mutex::new(RealtimeRecorder::new()),
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
