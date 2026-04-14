use tauri::Manager;
use std::sync::Mutex;

mod system_audio;
use system_audio::SystemAudioRecorder;

// Global state for the audio recorder
struct AppState {
    recorder: Mutex<SystemAudioRecorder>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            recorder: Mutex::new(SystemAudioRecorder::new()),
        })
        .setup(|app| {
            // Get the main window and set it up
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Wisprnote AI").ok();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_system_audio_available,
            start_system_audio,
            stop_system_audio,
            is_system_audio_recording,
            get_system_audio_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wisprnote AI");
}
