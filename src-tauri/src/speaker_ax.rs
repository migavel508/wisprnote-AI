//! Active-speaker name capture from meeting applications.
//!
//! Diarisation separates VOICES; it cannot know a voice belongs to Ada, because a
//! name is not recoverable from a waveform. Meeting apps publish no roster API, so
//! the only shared surface is the macOS accessibility tree — which for Chromium
//! apps mirrors the DOM, including CSS classes.
//!
//! # How each platform is read
//!
//! | Platform      | Read via     | Why |
//! |---------------|--------------|-----|
//! | Google Meet   | DOM classes  | obfuscated but stable per build |
//! | Slack huddles | DOM classes  | conventional BEM, expected to survive |
//! | Microsoft Teams | descriptions | its Fluent class hashes are style atoms shared by every button — useless as markers |
//! | Zoom (native) | descriptions | Cocoa, no DOM at all |
//! | FaceTime / Webex / Discord | — | publish no participant grid; recorded and diarised, speakers stay "Speaker N" |
//!
//! # Teams has no "is speaking" signal
//!
//! Teams never marks who is talking — not in descriptions, not in classes. It does
//! say who is MUTED, and a muted participant cannot be producing the audio on the
//! system tap. So when exactly one remote participant is unmuted, far-end speech is
//! necessarily theirs. That is a deduction from a fact, and it is abandoned the
//! moment a second person unmutes.

#![cfg(target_os = "macos")]

use crate::accessibility::{running_apps, AxElement};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Tree-walk bounds. Meeting windows are large and can contain cycles; an
/// unbounded walk would pin a core and can hang on a hostile tree.
const MAX_DEPTH: usize = 30;
const MAX_NODES: usize = 8_000;
/// Fast enough to catch a two-second turn; real meetings are full of them.
const POLL_FAST: Duration = Duration::from_millis(300);
/// Backed off once the reading stops changing, to stay off the critical path.
const POLL_IDLE: Duration = Duration::from_millis(1_200);
const IDLE_AFTER_UNCHANGED: u32 = 8;

const ZOOM_BUNDLES: &[&str] = &["us.zoom.xos"];
const TEAMS_BUNDLES: &[&str] = &["com.microsoft.teams"];
const SLACK_BUNDLES: &[&str] = &["com.tinyspeck.slackmacgap", "com.tinyspeck.slackdesktop", "com.slack.slack"];
const BROWSER_BUNDLES: &[&str] = &[
    "com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox",
    "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser",
];

/// Titles that mean a native app is IN a call rather than merely open.
///
/// Teams and Zoom run all day. Treating "the app is running" as "a call is
/// happening" lets an idle Teams beat a browser with a live Meet call in it.
const ZOOM_IN_CALL: &[&str] = &["zoom meeting", "zoom workplace meeting"];
const TEAMS_IN_CALL: &[&str] = &["meeting with", "meeting in", "| meeting"];
/// Titles that look like a call but are not one.
const NOT_IN_CALL: &[&str] = &["calendar", "chat |", "settings"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Zoom,
    GoogleMeet,
    Teams,
    Slack,
    /// Detected and recorded, but exposes no readable participant grid.
    Unsupported,
}

/// Which surface carries the participant information on this platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadVia {
    Classes,
    Descriptions,
}

impl Platform {
    fn read_via(&self) -> ReadVia {
        match self {
            Platform::GoogleMeet | Platform::Slack => ReadVia::Classes,
            _ => ReadVia::Descriptions,
        }
    }

    fn is_chromium(&self) -> bool {
        matches!(self, Platform::GoogleMeet | Platform::Teams | Platform::Slack)
    }
}

/// Per-platform selectors. Meet's are Google build artefacts and **will** change,
/// so every one is overridable at runtime — a rotted class is a config change
/// rather than a release.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerPollConfig {
    pub marker_classes: Vec<String>,
    pub tile_root_classes: Vec<String>,
}

impl SpeakerPollConfig {
    pub fn defaults_for(platform: Platform) -> SpeakerPollConfig {
        let (marker, root): (&[&str], &[&str]) = match platform {
            Platform::GoogleMeet => (&["kssMZb"], &["oZRSLe"]),
            Platform::Slack => (
                &["p-huddle_peer_tile__overlay--active_speaker"],
                &["p-huddle_peer_tile"],
            ),
            // Read from descriptions — no classes are involved.
            _ => (&[], &[]),
        };
        SpeakerPollConfig {
            marker_classes: marker.iter().map(|s| s.to_string()).collect(),
            tile_root_classes: root.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttributionState {
    Matched,
    Ambiguous,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerChange {
    pub speaker_name: Option<String>,
    /// Everyone found, whether or not they ever speak. The roster is most of the
    /// value: it names the voices the recogniser will separate even when no single
    /// moment can be pinned to a person.
    pub visible_names: Vec<String>,
    pub attribution_state: AttributionState,
    pub platform: Platform,
    /// Wall-clock ms, from the same clock the transcript turns are stamped with.
    pub timestamp_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/* ---------------------------------------------------------------- detection */

fn app_is_in_call(pid: i32, needles: &[&str]) -> bool {
    let Some(app) = AxElement::for_pid(pid) else { return false };
    app.window_titles().iter().any(|t| {
        let l = t.to_lowercase();
        needles.iter().any(|n| l.contains(n)) && !NOT_IN_CALL.iter().any(|n| l.contains(n))
    })
}

/// A live Slack huddle, rather than Slack merely being open.
///
/// Word boundaries matter: a channel named "huddle-planning" is not a huddle.
fn is_slack_huddle(title: &str) -> bool {
    let l = title.to_lowercase();
    l.contains("/huddle/") || l.contains('\u{1F3A4}') || {
        l.split(|c: char| !c.is_alphanumeric())
            .any(|w| w == "huddle")
            && (l.contains("huddle:") || l.contains("huddle -") || l.contains("| huddle"))
    }
}

fn hosts_huddle(pid: i32) -> bool {
    AxElement::for_pid(pid)
        .map(|a| a.window_titles().iter().any(|t| is_slack_huddle(t)))
        .unwrap_or(false)
}

fn browser_meeting(pid: i32) -> Option<Platform> {
    let app = AxElement::for_pid(pid)?;
    let titles = app.window_titles();
    if titles.iter().any(|t| {
        let l = t.to_lowercase();
        l.contains("meet.google.com") || l.contains("google meet")
    }) {
        return Some(Platform::GoogleMeet);
    }
    if titles.iter().any(|t| {
        let l = t.to_lowercase();
        l.contains("teams.microsoft.com") || l.contains("teams.live.com")
    }) {
        return Some(Platform::Teams);
    }
    None
}

/// Find the meeting platform and the process hosting it.
///
/// This walks the running applications itself rather than taking the microphone
/// holder from meeting detection. The mic signal exists to decide whether to
/// PROMPT; it is unset when the user starts recording by hand, or after the prompt
/// for that app has already been dismissed — which made capture silently no-op.
pub fn detect_platform() -> Option<(Platform, i32)> {
    let mut browser: Option<i32> = None;

    for (bundle, pid) in running_apps() {
        if ZOOM_BUNDLES.iter().any(|z| bundle.starts_with(z)) && app_is_in_call(pid, ZOOM_IN_CALL) {
            return Some((Platform::Zoom, pid));
        }
        if TEAMS_BUNDLES.iter().any(|t| bundle.starts_with(t)) && app_is_in_call(pid, TEAMS_IN_CALL) {
            return Some((Platform::Teams, pid));
        }
        if SLACK_BUNDLES.iter().any(|s| bundle.starts_with(s)) && hosts_huddle(pid) {
            return Some((Platform::Slack, pid));
        }
        if browser.is_none() && BROWSER_BUNDLES.iter().any(|b| bundle.starts_with(b)) {
            browser = Some(pid);
        }
    }

    // Only now, and only if a window says a call is happening.
    let pid = browser?;
    browser_meeting(pid).map(|p| (p, pid))
}

/* ------------------------------------------------------------ name parsing */

/// Role words apps put between the name and the state.
const ROLE_WORDS: &[&str] = &[
    "organizer", "organiser", "meeting guest", "guest", "presenter", "attendee",
    "co-organizer", "host", "co-host", "meeting organizer",
];

/// State words that follow the name.
const STATE_WORDS: &[&str] = &[
    "muted", "unmuted", "video is on", "video is off", "has context menu",
    "context menu is available", "speaking", "is speaking", "hand raised",
    "myself video", "pinned", "spotlighted", "camera is on", "camera is off",
];

pub fn normalize_name(raw: &str) -> Option<String> {
    let collapsed = raw.replace(['\r', '\n', '\t'], " ");
    let mut s = collapsed.split_whitespace().collect::<Vec<_>>().join(" ");
    for suffix in [" (You)", " (you)", " (Me)"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.to_string();
        }
    }
    let s = s.trim();
    if s.is_empty() || s.chars().count() > 200 {
        return None;
    }
    const CHROME: [&str; 7] = ["mute", "unmute", "camera", "present", "share screen", "you", "more"];
    if CHROME.contains(&s.to_lowercase().as_str()) {
        return None;
    }
    Some(s.to_string())
}

/// One participant, as a description string described them.
#[derive(Clone, Debug, PartialEq)]
pub struct Described {
    pub name: String,
    pub muted: bool,
    pub speaking: bool,
    /// The device owner's own tile, which Teams prefixes "Myself video".
    pub is_self: bool,
}

/// Parse a participant description of the form `"<name>, <role>, <state>…"`.
///
/// Returns None for anything that is not a participant — toolbars and buttons
/// carry descriptions too, and treating one as a person invents a participant
/// called "Share content".
pub fn parse_described(raw: &str) -> Option<Described> {
    let parts: Vec<&str> = raw.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let is_role = |p: &str| ROLE_WORDS.contains(&p.to_lowercase().as_str());
    let is_state = |p: &str| {
        let l = p.to_lowercase();
        STATE_WORDS.iter().any(|w| l == *w)
    };

    // The name is the first field that is neither a role nor a state. Skipping
    // leading state words is what keeps the owner from being named "Myself video".
    let name_at = parts.iter().position(|p| !is_role(p) && !is_state(p))?;

    // Every remaining field must be a role or a state. Without this, a button
    // labelled "Mute, Ada" would parse as a person; requiring the whole tail to be
    // known vocabulary is what separates a participant from a control.
    let tail = &parts[name_at + 1..];
    if tail.is_empty() || !tail.iter().all(|p| is_role(p) || is_state(p)) {
        return None;
    }

    let lower = raw.to_lowercase();
    let name = normalize_name(parts[name_at])?;
    Some(Described {
        name,
        muted: tail.iter().any(|p| p.eq_ignore_ascii_case("muted")),
        speaking: lower.contains("speaking"),
        is_self: parts[..name_at].iter().any(|p| p.eq_ignore_ascii_case("myself video")),
    })
}

struct Reading {
    speaking: Vec<String>,
    everyone: Vec<String>,
}

/// Fold a window's description strings into one reading.
fn read_descriptions(labels: &[String]) -> Reading {
    let mut people: BTreeMap<String, Described> = BTreeMap::new();
    for raw in labels {
        let Some(d) = parse_described(raw) else { continue };
        // Several nodes describe the same person — the roster row and the video
        // tile. Merge rather than duplicate, keeping any positive signal.
        let e = people.entry(d.name.clone()).or_insert_with(|| d.clone());
        e.speaking |= d.speaking;
        e.muted &= d.muted;
        e.is_self |= d.is_self;
    }

    let own_name = people.values().find(|d| d.is_self).map(|d| d.name.clone());
    let mut speaking: Vec<String> =
        people.values().filter(|d| d.speaking).map(|d| d.name.clone()).collect();

    // Attribution by ELIMINATION where the app never says who is talking.
    //
    // A muted participant cannot be producing the audio on the system tap, so when
    // exactly one remote is unmuted, far-end speech is necessarily theirs. The
    // owner is excluded: they are the microphone channel, already known, and not
    // what the far-end tap is hearing.
    if speaking.is_empty() {
        let candidates: Vec<String> = people
            .values()
            .filter(|d| !d.muted && !d.is_self)
            .filter(|d| Some(&d.name) != own_name.as_ref())
            .map(|d| d.name.clone())
            .collect();
        if candidates.len() == 1 {
            speaking = candidates;
        }
    }

    Reading { speaking, everyone: people.values().map(|d| d.name.clone()).collect() }
}

/* -------------------------------------------------------------- tree walks */

struct Walker {
    nodes: usize,
}

impl Walker {
    fn walk<F: FnMut(&AxElement)>(&mut self, el: &AxElement, depth: usize, f: &mut F) {
        if depth > MAX_DEPTH || self.nodes >= MAX_NODES {
            return;
        }
        self.nodes += 1;
        f(el);
        for child in el.elements("AXChildren") {
            self.walk(&child, depth + 1, f);
        }
    }
}

/// Every description string in the application tree.
fn collect_labels(root: &AxElement) -> Vec<String> {
    let mut out = Vec::new();
    let mut w = Walker { nodes: 0 };
    w.walk(root, 0, &mut |el| {
        if let Some(d) = el.string("AXDescription") {
            if d.contains(',') {
                out.push(d);
            }
        }
    });
    out
}

fn text_of(el: &AxElement) -> Option<String> {
    for attr in ["AXTitle", "AXValue", "AXDescription"] {
        if let Some(s) = el.string(attr) {
            if let Some(n) = normalize_name(&s) {
                return Some(n);
            }
        }
    }
    None
}

fn subtree_text(el: &AxElement, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    if let Some(t) = text_of(el) {
        return Some(t);
    }
    for child in el.elements("AXChildren") {
        if let Some(t) = subtree_text(&child, depth + 1) {
            return Some(t);
        }
    }
    None
}

fn has_any_class(el: &AxElement, wanted: &[String]) -> bool {
    if wanted.is_empty() {
        return false;
    }
    let classes = el.string_array("AXDOMClassList");
    classes.iter().any(|c| wanted.iter().any(|w| c == w))
}

fn tile_contains_marker(el: &AxElement, marker: &[String], depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    for child in el.elements("AXChildren") {
        if has_any_class(&child, marker) || tile_contains_marker(&child, marker, depth + 1) {
            return true;
        }
    }
    false
}

/// Class-based reading, for the platforms that expose a DOM.
fn read_classes(root: &AxElement, cfg: &SpeakerPollConfig) -> Reading {
    let mut speaking: Vec<String> = Vec::new();
    let mut everyone: Vec<String> = Vec::new();
    let mut w = Walker { nodes: 0 };

    w.walk(root, 0, &mut |el| {
        if !has_any_class(el, &cfg.tile_root_classes) {
            return;
        }
        let Some(name) = subtree_text(el, 0) else { return };
        if !everyone.contains(&name) {
            everyone.push(name.clone());
        }
        if has_any_class(el, &cfg.marker_classes)
            || tile_contains_marker(el, &cfg.marker_classes, 0)
        {
            if !speaking.contains(&name) {
                speaking.push(name);
            }
        }
    });

    Reading { speaking, everyone }
}

/// One polling pass.
pub fn read_once(pid: i32, platform: Platform, cfg: &SpeakerPollConfig) -> Option<SpeakerChange> {
    let app = AxElement::for_pid(pid)?;
    if platform.is_chromium() {
        // Set on EVERY poll: it does not survive a renderer restart, and without
        // it a Chromium tree is empty — which is indistinguishable from a call
        // with no participants.
        app.enable_chromium_accessibility();
    }

    let reading = match platform.read_via() {
        ReadVia::Classes => read_classes(&app, cfg),
        ReadVia::Descriptions => read_descriptions(&collect_labels(&app)),
    };

    // Exactly one speaking tile is trustworthy. Two or more means we genuinely
    // cannot say who is talking, and guessing would print a real person's name
    // over someone else's words.
    let (state, name) = match reading.speaking.len() {
        1 => (AttributionState::Matched, Some(reading.speaking[0].clone())),
        0 => (AttributionState::Unknown, None),
        _ => (AttributionState::Ambiguous, None),
    };

    Some(SpeakerChange {
        speaker_name: name,
        visible_names: reading.everyone,
        attribution_state: state,
        platform,
        timestamp_ms: now_ms(),
    })
}

/* ------------------------------------------------------------------ polling */

#[derive(Clone, Default)]
pub struct SpeakerPollState {
    running: Arc<AtomicBool>,
    pub last: Arc<Mutex<Option<SpeakerChange>>>,
}

impl SpeakerPollState {
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Poll `pid`, emitting `meeting-speaker-change` on every CHANGE.
    ///
    /// Adaptive cadence: fast while the conversation is moving, backing off once
    /// several reads in a row have changed nothing, so an idle call does not spend
    /// a core walking accessibility trees.
    pub fn start<R: tauri::Runtime>(
        &self,
        app_handle: tauri::AppHandle<R>,
        pid: i32,
        platform: Platform,
        cfg: SpeakerPollConfig,
    ) {
        use tauri::Emitter;

        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        let last = self.last.clone();

        std::thread::spawn(move || {
            let mut prev: Option<(Option<String>, AttributionState, usize)> = None;
            let mut unchanged: u32 = 0;
            while running.load(Ordering::SeqCst) {
                if let Some(change) = read_once(pid, platform, &cfg) {
                    let key = (
                        change.speaker_name.clone(),
                        change.attribution_state,
                        change.visible_names.len(),
                    );
                    if prev.as_ref() != Some(&key) {
                        prev = Some(key);
                        unchanged = 0;
                        if let Ok(mut g) = last.lock() {
                            *g = Some(change.clone());
                        }
                        let _ = app_handle.emit("meeting-speaker-change", &change);
                    } else {
                        unchanged = unchanged.saturating_add(1);
                    }
                }
                let wait = if unchanged >= IDLE_AFTER_UNCHANGED { POLL_IDLE } else { POLL_FAST };
                std::thread::sleep(wait);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tile_labels() {
        assert_eq!(normalize_name("  Ada  Lovelace \n"), Some("Ada Lovelace".into()));
        assert_eq!(normalize_name("Ada Lovelace (You)"), Some("Ada Lovelace".into()));
        assert_eq!(normalize_name("   "), None);
        assert_eq!(normalize_name("Mute"), None);
    }

    #[test]
    fn parses_a_participant_description() {
        let d = parse_described("Ada Lovelace, Organizer, Muted").unwrap();
        assert_eq!(d.name, "Ada Lovelace");
        assert!(d.muted);
        assert!(!d.is_self);
    }

    #[test]
    fn recognises_the_owner_tile() {
        let d = parse_described("Myself video, Ada Lovelace, Presenter, Unmuted").unwrap();
        // The owner must be named Ada, never "Myself video".
        assert_eq!(d.name, "Ada Lovelace");
        assert!(d.is_self);
    }

    #[test]
    fn rejects_controls_that_merely_contain_a_comma() {
        // A button must never become a participant.
        assert!(parse_described("Share content, click to present").is_none());
        assert!(parse_described("Ada Lovelace").is_none());
    }

    #[test]
    fn deduces_the_speaker_by_elimination_when_one_remote_is_unmuted() {
        // Teams never says who is speaking; a muted person cannot be the far-end
        // audio, so a single unmuted remote is necessarily the one talking.
        let labels = vec![
            "Myself video, Ada Lovelace, Organizer, Muted".to_string(),
            "Alan Turing, Presenter, Unmuted".to_string(),
            "Grace Hopper, Attendee, Muted".to_string(),
        ];
        let r = read_descriptions(&labels);
        assert_eq!(r.speaking, vec!["Alan Turing".to_string()]);
        assert_eq!(r.everyone.len(), 3);
    }

    #[test]
    fn refuses_to_guess_when_two_remotes_are_unmuted() {
        // The deduction collapses the moment a second person unmutes.
        let labels = vec![
            "Myself video, Ada Lovelace, Organizer, Muted".to_string(),
            "Alan Turing, Presenter, Unmuted".to_string(),
            "Grace Hopper, Attendee, Unmuted".to_string(),
        ];
        assert!(read_descriptions(&labels).speaking.is_empty());
    }

    #[test]
    fn an_explicit_speaking_state_beats_elimination() {
        let labels = vec![
            "Alan Turing, Presenter, Unmuted".to_string(),
            "Grace Hopper, Attendee, Speaking".to_string(),
        ];
        assert_eq!(read_descriptions(&labels).speaking, vec!["Grace Hopper".to_string()]);
    }

    #[test]
    fn slack_huddle_needs_more_than_the_word_huddle() {
        assert!(is_slack_huddle("Huddle: #design — Slack"));
        // A channel that merely has "huddle" in its name is not a live huddle.
        assert!(!is_slack_huddle("huddle-planning (channel) - Slack"));
    }

    #[test]
    fn class_platforms_have_selectors_and_description_platforms_do_not() {
        assert!(!SpeakerPollConfig::defaults_for(Platform::GoogleMeet).marker_classes.is_empty());
        assert!(!SpeakerPollConfig::defaults_for(Platform::Slack).tile_root_classes.is_empty());
        // Teams' Fluent hashes are style atoms — it must NOT key on classes.
        assert!(SpeakerPollConfig::defaults_for(Platform::Teams).marker_classes.is_empty());
        assert!(SpeakerPollConfig::defaults_for(Platform::Zoom).marker_classes.is_empty());
    }
}
