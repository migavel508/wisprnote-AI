use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct PermissionStatus {
    pub microphone: String,
    pub screen_recording: String,
}

#[cfg(target_os = "macos")]
pub mod macos {
    use super::PermissionStatus;
    use cidre::{av, ns};
    use cidre::core_audio as ca;

    pub fn check_permissions() -> PermissionStatus {
        PermissionStatus {
            microphone: check_microphone(),
            screen_recording: check_screen_recording(),
        }
    }

    fn check_microphone() -> String {
        match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
            Ok(status) => match status {
                av::AuthorizationStatus::NotDetermined => "not_determined".to_string(),
                av::AuthorizationStatus::Restricted => "denied".to_string(),
                av::AuthorizationStatus::Denied => "denied".to_string(),
                av::AuthorizationStatus::Authorized => "authorized".to_string(),
            },
            Err(_) => "not_determined".to_string(),
        }
    }

    fn check_screen_recording() -> String {
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        match tap_desc.create_process_tap() {
            Ok(_) => "authorized".to_string(),
            Err(_) => "denied".to_string(),
        }
    }

    pub fn request_microphone() -> Result<bool, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut block = cidre::blocks::SendBlock::new1(move |granted: bool| {
            let _ = tx.send(granted);
        });
        av::CaptureDevice::request_access_for_media_type_ch(
            av::MediaType::audio(),
            &mut block,
        ).map_err(|e| format!("{:?}", e))?;

        rx.recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|e| format!("Permission request timed out: {}", e))
    }

    pub fn open_screen_recording_settings() -> Result<(), String> {
        let urls = [
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ];

        for url in &urls {
            if let Ok(status) = std::process::Command::new("open").arg(url).status() {
                if status.success() {
                    return Ok(());
                }
            }
        }

        Err("Failed to open Screen Recording settings".to_string())
    }

    pub fn open_microphone_settings() -> Result<(), String> {
        let urls = [
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        ];

        for url in &urls {
            if let Ok(status) = std::process::Command::new("open").arg(url).status() {
                if status.success() {
                    return Ok(());
                }
            }
        }

        Err("Failed to open Microphone settings".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub mod stub {
    use super::PermissionStatus;

    pub fn check_permissions() -> PermissionStatus {
        PermissionStatus {
            microphone: "authorized".to_string(),
            screen_recording: "authorized".to_string(),
        }
    }

    pub fn request_microphone() -> Result<bool, String> {
        Ok(true)
    }

    pub fn open_screen_recording_settings() -> Result<(), String> {
        Ok(())
    }

    pub fn open_microphone_settings() -> Result<(), String> {
        Ok(())
    }
}
