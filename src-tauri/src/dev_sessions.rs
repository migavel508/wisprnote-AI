//! Local dev-session reader — Claude Code (`~/.claude/projects/*/*.jsonl`) and Codex
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
//!
//! These transcripts live on the user's machine, so the desktop app reads them natively here,
//! REDACTS secrets, and emits a small compact `SessionDigest` per session. The raw transcripts
//! (and the multi-GB Codex rollouts) never leave the machine — only the digest is uploaded to
//! the brain (`POST /connectors/local/ingest`), where it's distilled server-side.
//!
//! Cold Codex files are zstd-compressed (`.jsonl.zst`); v1 skips those and reports the count
//! (no silent cap). Files over `MAX_FILE_BYTES` are skipped (runaway sessions) and counted too.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const PROMPTS_CAP: usize = 24;
const ASSIST_CAP: usize = 16;
const FILES_CAP: usize = 60;
const CMDS_CAP: usize = 30;
const TEXT_CAP: usize = 600; // chars per snippet
const MAX_LINES: usize = 60_000; // bound time on huge sessions
const MAX_FILE_BYTES: u64 = 80 * 1024 * 1024; // skip pathological multi-GB rollouts

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionDigest {
    pub source: String, // "claude-code" | "codex"
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub turn_count: u32,
    pub user_prompts: Vec<String>,
    pub assistant_text: Vec<String>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub mtime_ms: u64, // for the client's incremental cursor
    pub bytes: u64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevProject {
    pub cwd: String,
    pub source: String,
    pub session_count: u32,
    pub last_active_ms: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub sessions: Vec<SessionDigest>,
    pub skipped_compressed: u32,
    pub skipped_large: u32,
    pub errors: u32,
}

// ── Redaction (token-scan; no regex dependency) ────────────────────────────────────────────

fn looks_secret(tok: &str) -> bool {
    let t: &str = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
    if t.len() < 16 {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    const PREFIXES: [&str; 13] = [
        "sk-", "sk_", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "xox", "akia", "asia",
        "aiza", "eyj", "glpat-",
    ];
    if PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    // Long, high-density alnum run that mixes letters AND digits = likely a key/token.
    if t.len() >= 32 {
        let dense = t
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
            .count();
        if (dense as f32) / (t.len() as f32) > 0.95
            && t.chars().any(|c| c.is_ascii_digit())
            && t.chars().any(|c| c.is_ascii_alphabetic())
        {
            return true;
        }
    }
    false
}

fn redact(s: &str) -> String {
    // Whole-line nuke for obvious private-key / env-secret material.
    if s.contains("PRIVATE KEY") || s.contains("BEGIN RSA") || s.contains("BEGIN OPENSSH") {
        return "‹redacted: key material›".to_string();
    }
    let mut out = String::with_capacity(s.len());
    for (i, tok) in s.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if looks_secret(tok) {
            out.push_str("‹redacted›");
        } else {
            out.push_str(tok);
        }
    }
    out
}

fn clip(s: &str, n: usize) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let red = redact(&collapsed);
    red.chars().take(n).collect()
}

fn rel(cwd: &str, path: &str) -> String {
    if !cwd.is_empty() && path.starts_with(cwd) {
        path[cwd.len()..].trim_start_matches('/').to_string()
    } else {
        path.to_string()
    }
}

// ── Generic helpers over serde_json::Value ─────────────────────────────────────────────────

/// Pull readable text from a value that may be a string, {text}, or an array of content blocks.
fn value_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect::<Vec<_>>()
            .join(" "),
        serde_json::Value::Object(o) => o
            .get("text")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

const NOISE_PREFIXES: [&str; 6] = [
    "<system-reminder>",
    "<command-name>",
    "<local-command-stdout>",
    "Caveat:",
    "[Request interrupted",
    "<command-message>",
];

fn is_noise_prompt(s: &str) -> bool {
    let t = s.trim_start();
    t.is_empty() || NOISE_PREFIXES.iter().any(|p| t.starts_with(p))
}

fn mtime_ms_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn push_capped(v: &mut Vec<String>, s: String, cap: usize) {
    if v.len() < cap && !s.is_empty() {
        v.push(s);
    }
}
fn track_time(min: &mut Option<String>, max: &mut Option<String>, ts: &str) {
    if ts.is_empty() {
        return;
    }
    if min.as_deref().map_or(true, |m| ts < m) {
        *min = Some(ts.to_string());
    }
    if max.as_deref().map_or(true, |m| ts > m) {
        *max = Some(ts.to_string());
    }
}

// ── Claude Code ────────────────────────────────────────────────────────────────────────────

fn parse_claude_session(path: &Path) -> Option<SessionDigest> {
    let meta = fs::metadata(path).ok()?;
    let bytes = meta.len();
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut d = SessionDigest {
        source: "claude-code".into(),
        session_id: path.file_stem()?.to_string_lossy().to_string(),
        mtime_ms: mtime_ms_of(path),
        bytes,
        ..Default::default()
    };
    let (mut min_t, mut max_t) = (None, None);
    let mut files_seen: Vec<String> = Vec::new();

    for (i, line) in reader.lines().enumerate() {
        if i >= MAX_LINES {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let o: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if o.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
            continue; // subagent noise
        }
        let kind = o.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if d.cwd.is_empty() {
            if let Some(c) = o.get("cwd").and_then(|c| c.as_str()) {
                d.cwd = c.to_string();
            }
        }
        if d.git_branch.is_none() {
            if let Some(b) = o.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    d.git_branch = Some(b.to_string());
                }
            }
        }
        if let Some(ts) = o.get("timestamp").and_then(|t| t.as_str()) {
            track_time(&mut min_t, &mut max_t, ts);
        }
        let msg = match o.get("message") {
            Some(m) => m,
            None => continue,
        };
        match kind {
            "user" => {
                d.turn_count += 1;
                // genuine prompts arrive as a plain string; arrays are tool_result returns
                if let Some(s) = msg.get("content").and_then(|c| c.as_str()) {
                    if !is_noise_prompt(s) {
                        push_capped(&mut d.user_prompts, clip(s, TEXT_CAP), PROMPTS_CAP);
                    }
                }
            }
            "assistant" => {
                d.turn_count += 1;
                if d.model.is_none() {
                    if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
                        d.model = Some(m.to_string());
                    }
                }
                if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in blocks {
                        match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                            "text" => {
                                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                    push_capped(&mut d.assistant_text, clip(t, TEXT_CAP), ASSIST_CAP);
                                }
                            }
                            "tool_use" => {
                                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                let input = b.get("input");
                                if let Some(fp) = input
                                    .and_then(|i| i.get("file_path"))
                                    .and_then(|p| p.as_str())
                                {
                                    let r = rel(&d.cwd, fp);
                                    if files_seen.len() < FILES_CAP && !files_seen.contains(&r) {
                                        files_seen.push(r);
                                    }
                                } else if name == "Bash" {
                                    if let Some(cmd) = input
                                        .and_then(|i| i.get("command"))
                                        .and_then(|c| c.as_str())
                                    {
                                        push_capped(&mut d.commands, clip(cmd, 120), CMDS_CAP);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    d.files = files_seen;
    d.started_at = min_t;
    d.ended_at = max_t;
    if d.user_prompts.is_empty() && d.assistant_text.is_empty() {
        return None; // not a real conversation (warmup/empty)
    }
    Some(d)
}

fn claude_session_files(home: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let root = PathBuf::from(home).join(".claude").join("projects");
    let proj_dirs = match fs::read_dir(&root) {
        Ok(d) => d,
        Err(_) => return out,
    };
    for proj in proj_dirs.flatten() {
        let p = proj.path();
        if !p.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&p) {
            for e in entries.flatten() {
                let f = e.path();
                if f.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("agent-") || name.contains("warmup") {
                    continue;
                }
                out.push(f);
            }
        }
    }
    out
}

// ── Codex ──────────────────────────────────────────────────────────────────────────────────

fn parse_codex_session(path: &Path) -> Option<SessionDigest> {
    let meta = fs::metadata(path).ok()?;
    let bytes = meta.len();
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut d = SessionDigest {
        source: "codex".into(),
        session_id: path.file_stem()?.to_string_lossy().to_string(),
        mtime_ms: mtime_ms_of(path),
        bytes,
        ..Default::default()
    };
    let (mut min_t, mut max_t) = (None, None);
    let mut files_seen: Vec<String> = Vec::new();

    for (i, line) in reader.lines().enumerate() {
        if i >= MAX_LINES {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let o: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(ts) = o.get("timestamp").and_then(|t| t.as_str()) {
            track_time(&mut min_t, &mut max_t, ts);
        }
        let kind = o.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let p = match o.get("payload") {
            Some(p) => p,
            None => continue,
        };
        match kind {
            "session_meta" => {
                if let Some(id) = p.get("id").and_then(|x| x.as_str()) {
                    d.session_id = id.to_string();
                }
                if let Some(c) = p.get("cwd").and_then(|x| x.as_str()) {
                    d.cwd = c.to_string();
                }
                if let Some(m) = p.get("model").and_then(|x| x.as_str()) {
                    d.model = Some(m.to_string());
                }
            }
            "event_msg" => {
                let et = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match et {
                    "user_message" => {
                        d.turn_count += 1;
                        let t = p.get("message").map(value_text).unwrap_or_default();
                        if !is_noise_prompt(&t) {
                            push_capped(&mut d.user_prompts, clip(&t, TEXT_CAP), PROMPTS_CAP);
                        }
                    }
                    "agent_message" => {
                        d.turn_count += 1;
                        let t = p.get("message").map(value_text).unwrap_or_default();
                        push_capped(&mut d.assistant_text, clip(&t, TEXT_CAP), ASSIST_CAP);
                    }
                    _ => {}
                }
            }
            "response_item" => {
                // function/tool calls carry edited files + shell commands
                let it = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if it == "function_call" {
                    let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let args = p
                        .get("arguments")
                        .and_then(|a| a.as_str())
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                    if let Some(args) = args {
                        if name.contains("shell") || name.contains("exec") || name == "local_shell" {
                            // command is usually an array of argv or a string
                            let cmd = match args.get("command") {
                                Some(serde_json::Value::Array(a)) => a
                                    .iter()
                                    .filter_map(|x| x.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                                Some(serde_json::Value::String(s)) => s.clone(),
                                _ => String::new(),
                            };
                            if !cmd.is_empty() {
                                push_capped(&mut d.commands, clip(&cmd, 120), CMDS_CAP);
                            }
                        }
                        for key in ["path", "file_path", "filename"] {
                            if let Some(fp) = args.get(key).and_then(|p| p.as_str()) {
                                let r = rel(&d.cwd, fp);
                                if files_seen.len() < FILES_CAP && !files_seen.contains(&r) {
                                    files_seen.push(r);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    d.files = files_seen;
    d.started_at = min_t;
    d.ended_at = max_t;
    if d.user_prompts.is_empty() && d.assistant_text.is_empty() {
        return None;
    }
    Some(d)
}

fn codex_session_files(home: &str, out: &mut Vec<PathBuf>, compressed: &mut u32) {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, compressed: &mut u32) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out, compressed);
            } else {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with("rollout-") {
                    continue;
                }
                if name.ends_with(".jsonl.zst") || name.ends_with(".zst") {
                    *compressed += 1;
                } else if name.ends_with(".jsonl") {
                    out.push(p);
                }
            }
        }
    }
    let root = PathBuf::from(home).join(".codex").join("sessions");
    walk(&root, out, compressed);
}

// ── Tauri commands ───────────────────────────────────────────────────────────────────────

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}

/// Path-prefix match: a session belongs to a connected project when its cwd equals or sits
/// under one of the mapped paths.
fn cwd_allowed(cwd: &str, filter: &Option<Vec<String>>) -> bool {
    match filter {
        None => true,
        Some(paths) => paths.iter().any(|p| {
            let p = p.trim_end_matches('/');
            cwd == p || cwd.starts_with(&format!("{}/", p))
        }),
    }
}

/// Scan local Claude Code + Codex sessions into compact digests.
/// `filter_paths` = only sessions whose cwd is one of these (connected projects); None = all.
/// `since_ms` = only files modified after this epoch-ms (incremental cursor); None = all.
#[tauri::command]
pub fn scan_dev_sessions(
    filter_paths: Option<Vec<String>>,
    since_ms: Option<u64>,
) -> ScanResult {
    let mut res = ScanResult::default();
    let home = match home_dir() {
        Some(h) => h,
        None => return res,
    };
    let since = since_ms.unwrap_or(0);

    // Claude Code
    for path in claude_session_files(&home) {
        let mt = mtime_ms_of(&path);
        if mt <= since {
            continue;
        }
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            res.skipped_large += 1;
            continue;
        }
        match parse_claude_session(&path) {
            Some(d) if cwd_allowed(&d.cwd, &filter_paths) => res.sessions.push(d),
            Some(_) => {}
            None => {}
        }
    }

    // Codex
    let mut codex_files = Vec::new();
    codex_session_files(&home, &mut codex_files, &mut res.skipped_compressed);
    for path in codex_files {
        let mt = mtime_ms_of(&path);
        if mt <= since {
            continue;
        }
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            res.skipped_large += 1;
            continue;
        }
        match parse_codex_session(&path) {
            Some(d) if cwd_allowed(&d.cwd, &filter_paths) => res.sessions.push(d),
            Some(_) => {}
            None => {}
        }
    }

    res
}

/// List detected local projects (grouped by cwd) so the UI can map each to a workspace folder.
/// Reads each session shallowly; bounded by the same caps as the full scan.
#[tauri::command]
pub fn list_dev_projects() -> Vec<DevProject> {
    let mut by_cwd: BTreeMap<(String, String), DevProject> = BTreeMap::new();
    let home = match home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };

    let mut record = |cwd: String, source: &str, mt: u64| {
        if cwd.is_empty() {
            return;
        }
        let entry = by_cwd
            .entry((cwd.clone(), source.to_string()))
            .or_insert_with(|| DevProject {
                cwd,
                source: source.to_string(),
                ..Default::default()
            });
        entry.session_count += 1;
        if mt > entry.last_active_ms {
            entry.last_active_ms = mt;
        }
    };

    for path in claude_session_files(&home) {
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            continue;
        }
        if let Some(d) = parse_claude_session(&path) {
            record(d.cwd, "claude-code", d.mtime_ms);
        }
    }
    let mut codex_files = Vec::new();
    let mut _c = 0u32;
    codex_session_files(&home, &mut codex_files, &mut _c);
    for path in codex_files {
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            continue;
        }
        if let Some(d) = parse_codex_session(&path) {
            record(d.cwd, "codex", d.mtime_ms);
        }
    }

    by_cwd.into_values().collect()
}
