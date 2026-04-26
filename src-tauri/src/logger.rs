// ─── Frontend Log Writer ──────────────────────────────────────────────────────
//
// Receives batched JSON log entries from the TypeScript logger and writes them
// as NDJSON (newline-delimited JSON) to rotating log files in:
//   <appDataDir>/logs/app-YYYY-MM-DD.log
//
// Rotation: one file per calendar day, old files are NOT auto-deleted
// (users/support can prune manually).
//
// ──────────────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

/// Mirror of the TypeScript LogEntry shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub module: String,
    pub event: String,
    pub context: Option<serde_json::Value>,
}

/// Resolve the log directory, creating it if needed.
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve appDataDir: {e}"))?;
    let dir = base.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log dir: {e}"))?;
    Ok(dir)
}

/// Build today's log filename: `app-2025-04-26.log`
fn today_filename() -> String {
    let now = chrono::Local::now();
    format!("app-{}.log", now.format("%Y-%m-%d"))
}

/// Tauri command: receives a batch of log entries from the frontend and appends
/// them as NDJSON lines to the day's log file.
#[tauri::command]
pub fn write_logs(entries: Vec<LogEntry>, app: tauri::AppHandle) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }

    let dir = log_dir(&app)?;
    let path = dir.join(today_filename());

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open log file {:?}: {e}", path))?;

    for entry in &entries {
        let line = serde_json::to_string(entry)
            .map_err(|e| format!("Failed to serialize log entry: {e}"))?;
        writeln!(file, "{}", line)
            .map_err(|e| format!("Failed to write log entry: {e}"))?;
    }

    file.flush()
        .map_err(|e| format!("Failed to flush log file: {e}"))?;

    Ok(())
}
