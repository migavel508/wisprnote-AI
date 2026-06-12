//! Microphone / meeting detection (macOS).
//!
//! Mirrors anarlog's `detect` plugin but self-contained: it reuses the `cidre`
//! CoreAudio bindings the recorder already depends on, so it needs no extra
//! crates. A background thread polls CoreAudio for processes that are actively
//! using an audio *input* (the microphone). When a non-ignored app (Zoom,
//! Google Meet in a browser, Teams, Slack, …) has held the mic continuously
//! past a short threshold, we emit a `mic-detected` Tauri event so the UI can
//! offer to start recording. When all such apps release the mic we emit
//! `mic-stopped`.
//!
//! Detection can be paused (e.g. while *we* are recording) via the
//! `set_detection_paused` command so our own capture never re-triggers a prompt.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// The detected mic-using app surfaced to the UI.
#[derive(Clone, Serialize)]
pub struct MicDetectedInfo {
    pub bundle_id: String,
    pub app_name: String,
}

/// Shared, cheaply-cloneable handle to the detector's runtime flags. Managed by
/// Tauri so commands can flip them and the meeting-prompt window can fetch the
/// latest detection on open (no event race).
///
/// - `enabled`: detection is on (set true once signed in). Default off.
/// - `paused`: temporarily suppressed (set while *we* are recording).
#[derive(Clone, Default)]
pub struct MicDetectState {
    pub enabled: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub last_detected: Arc<Mutex<Option<MicDetectedInfo>>>,
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    use cidre::core_audio as ca;
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    use super::{MicDetectState, MicDetectedInfo};

    const MEETING_PROMPT_LABEL: &str = "meeting-prompt";

    /// How often we sample CoreAudio for mic-using processes. Fast poll so we
    /// catch a meeting almost the instant it starts.
    const POLL_INTERVAL: Duration = Duration::from_millis(700);
    /// Continuous mic usage required before we surface a prompt. Kept short so
    /// detection feels instant, but non-zero to skip a momentary mic blip.
    const DETECT_THRESHOLD: Duration = Duration::from_millis(1500);
    /// After prompting for an app, stay quiet about it for this long so the user
    /// isn't nagged repeatedly during one call.
    const COOLDOWN: Duration = Duration::from_secs(5 * 60);

    /// Our own bundle id — capturing audio must never trigger a self-prompt.
    const SELF_BUNDLE_IDS: &[&str] = &["com.wisprnote.ai"];

    /// Apps that legitimately use the mic but are not "meetings". Browsers are
    /// deliberately NOT here — Google Meet / Zoom-web run inside a browser.
    const IGNORED_BUNDLE_IDS: &[&str] = &[
        "com.apple.voicememos",
        "com.apple.siri",
        "com.apple.speech.speechsynthesisserver",
        "com.electron.wispr-flow",
        "com.superduper.superwhisper",
        "com.goodsnooze.macwhisper",
        "com.prakashjoshipax.voiceink",
        "com.descript.beachcube",
        "com.microsoft.vscode",
        "dev.warp.warp-stable",
        "com.raycast.macos",
    ];

    /// Apple system processes that hold the mic but are NEVER meetings — Siri,
    /// dictation, Core Speech daemon (`corespeechd`), accessibility, etc. We
    /// ignore the whole `com.apple.*` namespace and keep only genuine meeting apps.
    const APPLE_MEETING_ALLOW: &[&str] = &["com.apple.facetime"];

    fn is_ignored(bundle_id: &str) -> bool {
        let id = bundle_id.to_lowercase();
        if SELF_BUNDLE_IDS.contains(&id.as_str()) || IGNORED_BUNDLE_IDS.contains(&id.as_str()) {
            return true;
        }
        // Ignore every Apple system daemon (corespeechd, dictation, Siri, …)
        // except real meeting apps like FaceTime — these caused false "meeting"
        // prompts whenever macOS speech/dictation grabbed the microphone.
        if id.starts_with("com.apple.") && !APPLE_MEETING_ALLOW.contains(&id.as_str()) {
            return true;
        }
        false
    }

    /// A friendly, human display name for a bundle id. Known meeting apps get a
    /// curated label; everything else falls back to the title-cased last segment
    /// of the bundle id (e.g. `com.acme.FooBar` -> `FooBar`).
    fn friendly_name(bundle_id: &str) -> String {
        let id = bundle_id.to_lowercase();
        const KNOWN: &[(&str, &str)] = &[
            ("us.zoom.xos", "Zoom"),
            ("com.microsoft.teams", "Microsoft Teams"),
            ("com.microsoft.teams2", "Microsoft Teams"),
            ("com.tinyspeck.slackmacgap", "Slack"),
            ("com.google.chrome", "Google Chrome"),
            ("com.google.chrome.beta", "Google Chrome"),
            ("com.apple.safari", "Safari"),
            ("com.microsoft.edgemac", "Microsoft Edge"),
            ("com.brave.browser", "Brave"),
            ("company.thebrowser.browser", "Arc"),
            ("org.mozilla.firefox", "Firefox"),
            ("com.hnc.discord", "Discord"),
            ("com.cisco.webexmeetingsapp", "Webex"),
            ("com.webex.meetingmanager", "Webex"),
            ("net.whatsapp.whatsapp", "WhatsApp"),
            ("com.facebook.archon", "Messenger"),
            ("com.skype.skype", "Skype"),
            ("com.apple.facetime", "FaceTime"),
        ];
        for (k, v) in KNOWN {
            if id == *k {
                return (*v).to_string();
            }
        }
        let last = bundle_id.rsplit('.').next().unwrap_or(bundle_id);
        let cleaned = last.replace(['-', '_'], " ");
        let mut chars = cleaned.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => bundle_id.to_string(),
        }
    }

    /// Bundle ids of non-ignored apps that currently hold the mic.
    fn active_mic_apps() -> Vec<String> {
        let processes = match ca::System::processes() {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };

        let mut out = Vec::new();
        for process in processes {
            if !matches!(process.is_running_input(), Ok(true)) {
                continue;
            }
            let Ok(bundle_id) = process.bundle_id() else {
                continue;
            };
            let bundle_id = bundle_id.to_string();
            if bundle_id.is_empty() || is_ignored(&bundle_id) {
                continue;
            }
            if !out.contains(&bundle_id) {
                out.push(bundle_id);
            }
        }
        out
    }

    pub fn spawn<R: Runtime>(app: AppHandle<R>, state: MicDetectState) {
        std::thread::spawn(move || {
            // When each currently-active app first appeared.
            let mut seen_since: HashMap<String, Instant> = HashMap::new();
            // Apps we've already prompted for — don't re-emit until they reappear.
            let mut prompted: HashMap<String, Instant> = HashMap::new();
            // Per-app cooldown end time.
            let mut cooldown_until: HashMap<String, Instant> = HashMap::new();
            let mut episode_active = false;

            loop {
                std::thread::sleep(POLL_INTERVAL);

                if !state.enabled.load(Ordering::SeqCst) || state.paused.load(Ordering::SeqCst) {
                    // Disabled (not signed in) or paused (we're recording): forget
                    // transient state so a fresh episode is detected cleanly once
                    // detection is active again.
                    seen_since.clear();
                    prompted.clear();
                    episode_active = false;
                    continue;
                }

                let active = active_mic_apps();
                let now = Instant::now();

                // Drop tracking for apps that released the mic.
                seen_since.retain(|id, _| active.contains(id));
                prompted.retain(|id, _| active.contains(id));

                for bundle_id in &active {
                    if let Some(until) = cooldown_until.get(bundle_id) {
                        if now < *until {
                            continue;
                        }
                    }

                    let first = seen_since.entry(bundle_id.clone()).or_insert(now);
                    if now.duration_since(*first) < DETECT_THRESHOLD {
                        continue;
                    }
                    if prompted.contains_key(bundle_id) {
                        continue;
                    }

                    prompted.insert(bundle_id.clone(), now);
                    cooldown_until.insert(bundle_id.clone(), now + COOLDOWN);

                    let payload = MicDetectedInfo {
                        bundle_id: bundle_id.clone(),
                        app_name: friendly_name(bundle_id),
                    };
                    if let Ok(mut last) = state.last_detected.lock() {
                        *last = Some(payload.clone());
                    }
                    let _ = app.emit("mic-detected", payload);

                    // Show the (pre-created, hidden) prompt overlay straight from
                    // Rust — not subject to the backgrounded main WebView's timer
                    // throttling — so it appears the instant a meeting is detected.
                    if let Some(win) = app.get_webview_window(MEETING_PROMPT_LABEL) {
                        // Join all spaces + full-screen aux so it pops OVER a
                        // fullscreen meeting (Zoom/Teams/Meet), not behind it.
                        let _ = win.set_visible_on_all_workspaces(true);
                        let _ = win.set_always_on_top(true);
                        let _ = win.show();
                        // Tell the passthrough poll the prompt is up so it begins
                        // hit-testing (otherwise it stays fully click-through and
                        // the "Take Notes" button wouldn't receive clicks).
                        crate::mark_overlay_visible(MEETING_PROMPT_LABEL, true);
                    }
                }

                let any_active = !active.is_empty();
                if episode_active && !any_active {
                    if let Ok(mut last) = state.last_detected.lock() {
                        *last = None;
                    }
                    let _ = app.emit("mic-stopped", ());
                }
                episode_active = any_active;
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub fn spawn<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: MicDetectState) {
    imp::spawn(app, state);
}

#[cfg(not(target_os = "macos"))]
pub fn spawn<R: tauri::Runtime>(_app: tauri::AppHandle<R>, _state: MicDetectState) {
    // Detection relies on macOS CoreAudio; no-op elsewhere.
}
