/// Audio Device enumeration and detection for macOS
/// Lists input/output devices, detects transport type (Bluetooth, USB, BuiltIn, etc.)
/// and identifies headphones. Inspired by char's audio-device crate.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportType {
    BuiltIn,
    Usb,
    Bluetooth,
    Hdmi,
    Virtual,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioDirection {
    Input,
    Output,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub direction: AudioDirection,
    pub transport_type: TransportType,
    pub is_default: bool,
    pub is_headphone: bool,
}

#[cfg(target_os = "macos")]
pub mod macos {
    use cidre::core_audio as ca;
    use cidre::cf;

    use super::*;

    fn ca_transport_to_transport_type(transport: ca::DeviceTransportType) -> TransportType {
        if transport == ca::DeviceTransportType::BUILT_IN {
            TransportType::BuiltIn
        } else if transport == ca::DeviceTransportType::USB {
            TransportType::Usb
        } else if transport == ca::DeviceTransportType::BLUETOOTH
            || transport == ca::DeviceTransportType::BLUETOOTH_LE
        {
            TransportType::Bluetooth
        } else if transport == ca::DeviceTransportType::HDMI
            || transport == ca::DeviceTransportType::DISPLAY_PORT
        {
            TransportType::Hdmi
        } else if transport == ca::DeviceTransportType::VIRTUAL
            || transport == ca::DeviceTransportType::AGGREGATE
        {
            TransportType::Virtual
        } else {
            TransportType::Unknown
        }
    }

    fn has_streams(device: &ca::Device, scope: ca::PropScope) -> bool {
        let addr = ca::PropSelector::DEVICE_STREAMS.addr(scope, ca::PropElement::MAIN);
        device
            .prop_size(&addr)
            .map(|size| size > 0)
            .unwrap_or(false)
    }

    fn detect_headphone(device: &ca::Device, transport: &TransportType, name: &str) -> bool {
        // Check via stream terminal type first
        if let Ok(streams) = device.streams() {
            let detected = streams.iter().any(|s| {
                s.terminal_type().ok().is_some_and(|term_type| {
                    term_type == ca::StreamTerminalType::HEADPHONES
                        || term_type == ca::StreamTerminalType::HEADSET_MIC
                })
            });
            if detected {
                return true;
            }
        }

        // Fall back to transport type + name heuristics
        match transport {
            TransportType::Bluetooth => true,
            TransportType::Usb => {
                let lower = name.to_lowercase();
                lower.contains("headphone")
                    || lower.contains("headset")
                    || lower.contains("airpod")
                    || lower.contains("earbud")
            }
            TransportType::BuiltIn => {
                name.to_lowercase().contains("headphone")
            }
            _ => false,
        }
    }

    fn create_audio_device(
        ca_device: &ca::Device,
        direction: AudioDirection,
        default_id: Option<u32>,
    ) -> Option<AudioDevice> {
        let scope = match direction {
            AudioDirection::Input => ca::PropScope::INPUT,
            AudioDirection::Output => ca::PropScope::OUTPUT,
        };

        if !has_streams(ca_device, scope) {
            return None;
        }

        let uid = ca_device.uid().ok()?;
        let name = ca_device.name().ok()?;
        let transport_type = ca_device
            .transport_type()
            .map(ca_transport_to_transport_type)
            .unwrap_or(TransportType::Unknown);

        let is_default = default_id
            .map(|id| ca_device.0.0 == id)
            .unwrap_or(false);

        let is_headphone = if direction == AudioDirection::Output {
            detect_headphone(ca_device, &transport_type, &name.to_string())
        } else {
            false
        };

        Some(AudioDevice {
            id: uid.to_string(),
            name: name.to_string(),
            direction,
            transport_type,
            is_default,
            is_headphone,
        })
    }

    const TAP_DEVICE_NAME: &str = "WisprnoteAudioCapture";
    const REALTIME_TAP_NAME: &str = "WisprnoteRealtimeCapture";

    pub fn list_all_devices() -> Result<Vec<AudioDevice>, String> {
        let ca_devices =
            ca::System::devices().map_err(|e| format!("Failed to enumerate devices: {:?}", e))?;

        let default_input_id = ca::System::default_input_device().ok().map(|d| d.0.0);
        let default_output_id = ca::System::default_output_device().ok().map(|d| d.0.0);

        let mut devices = Vec::new();

        for ca_device in ca_devices {
            // Skip our own aggregate/tap devices
            if let Ok(name) = ca_device.name() {
                let n = name.to_string();
                if n.contains(TAP_DEVICE_NAME) || n.contains(REALTIME_TAP_NAME) {
                    continue;
                }
            }

            if let Some(input) =
                create_audio_device(&ca_device, AudioDirection::Input, default_input_id)
            {
                devices.push(input);
            }

            if let Some(output) =
                create_audio_device(&ca_device, AudioDirection::Output, default_output_id)
            {
                devices.push(output);
            }
        }

        Ok(devices)
    }

    pub fn get_default_input_device() -> Result<Option<AudioDevice>, String> {
        let ca_device = match ca::System::default_input_device() {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        if ca_device.is_unknown() {
            return Ok(None);
        }

        Ok(create_audio_device(
            &ca_device,
            AudioDirection::Input,
            Some(ca_device.0.0),
        ))
    }

    pub fn get_default_output_device() -> Result<Option<AudioDevice>, String> {
        let ca_device = match ca::System::default_output_device() {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        if ca_device.is_unknown() {
            return Ok(None);
        }

        Ok(create_audio_device(
            &ca_device,
            AudioDirection::Output,
            Some(ca_device.0.0),
        ))
    }

    pub fn set_default_input_device(device_id: &str) -> Result<(), String> {
        let uid = cf::String::from_str(device_id);
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| format!("Device not found: {}: {:?}", device_id, e))?;

        if ca_device.is_unknown() {
            return Err(format!("Device not found: {}", device_id));
        }

        ca::System::OBJ
            .set_prop(
                &ca::PropSelector::HW_DEFAULT_INPUT_DEVICE.global_addr(),
                &ca_device.0,
            )
            .map_err(|e| format!("Failed to set default input: {:?}", e))?;

        Ok(())
    }

    pub fn set_default_output_device(device_id: &str) -> Result<(), String> {
        let uid = cf::String::from_str(device_id);
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| format!("Device not found: {}: {:?}", device_id, e))?;

        if ca_device.is_unknown() {
            return Err(format!("Device not found: {}", device_id));
        }

        ca::System::OBJ
            .set_prop(
                &ca::PropSelector::HW_DEFAULT_OUTPUT_DEVICE.global_addr(),
                &ca_device.0,
            )
            .map_err(|e| format!("Failed to set default output: {:?}", e))?;

        Ok(())
    }
}

// ─── Stubs for non-macOS ─────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub mod stub {
    use super::*;

    pub fn list_all_devices() -> Result<Vec<AudioDevice>, String> {
        Ok(vec![])
    }

    pub fn get_default_input_device() -> Result<Option<AudioDevice>, String> {
        Ok(None)
    }

    pub fn get_default_output_device() -> Result<Option<AudioDevice>, String> {
        Ok(None)
    }

    pub fn set_default_input_device(_device_id: &str) -> Result<(), String> {
        Err("Not supported on this platform".to_string())
    }

    pub fn set_default_output_device(_device_id: &str) -> Result<(), String> {
        Err("Not supported on this platform".to_string())
    }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub use macos::{
    get_default_input_device, get_default_output_device, list_all_devices,
    set_default_input_device, set_default_output_device,
};

#[cfg(not(target_os = "macos"))]
pub use stub::{
    get_default_input_device, get_default_output_device, list_all_devices,
    set_default_input_device, set_default_output_device,
};
