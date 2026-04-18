use tauri::{Manager, Emitter};
use tauri::tray::TrayIconEvent;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use std::sync::Mutex;

mod audio_device;
mod deepgram_transcriber;
mod device_monitor;
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
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut recorder = state.realtime_recorder.lock().map_err(|e| e.to_string())?;
    recorder.start(api_key, app_handle)
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
        .manage(AppState {
            recorder: Mutex::new(SystemAudioRecorder::new()),
            realtime_recorder: Mutex::new(RealtimeRecorder::new()),
        })
        .setup(|app| {
            // Get the main window and set it up
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Wisprnote AI").ok();

            // Spawn audio device monitor — emits events when mic/speaker changes
            let monitor_handle = app.handle().clone();
            let (dev_tx, dev_rx) = std::sync::mpsc::channel();
            let _monitor = device_monitor::spawn_monitor(dev_tx);
            std::thread::spawn(move || {
                while let Ok(change) = dev_rx.recv() {
                    let event_name = match &change {
                        device_monitor::DeviceChange::DefaultInputChanged => "audio-device-change",
                        device_monitor::DeviceChange::DefaultOutputChanged => "audio-device-change",
                        device_monitor::DeviceChange::DeviceListChanged => "audio-device-change",
                    };
                    let payload = match &change {
                        device_monitor::DeviceChange::DefaultInputChanged => "input-changed",
                        device_monitor::DeviceChange::DefaultOutputChanged => "output-changed",
                        device_monitor::DeviceChange::DeviceListChanged => "device-list-changed",
                    };
                    let _ = monitor_handle.emit(event_name, payload);
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
            check_permissions,
            request_microphone_permission,
            open_screen_recording_settings,
            open_microphone_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wisprnote AI");
}
