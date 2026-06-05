//! Tiny dependency-free file logger.
//!
//! StagePal ships as a windowed app with no console, so `eprintln!` output is
//! invisible to end users — and most of them can't run a Rust toolchain to dig
//! into a crash. This module writes timestamped lines to a real log file in the
//! OS log directory (surfaced to the UI via `get_log_path` / `read_log`) so a
//! failed ASIO open leaves an artifact the user can read or send back to us.
//!
//! Call `logging::init(path)` once at startup; thereafter `linfo!/lwarn!/lerror!`
//! (or `logging::write`) append a line. Everything is best-effort: a logging
//! failure must never take down audio, so write errors are swallowed.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::model::now_unix_ms;

struct Sink {
    path: PathBuf,
    file: std::fs::File,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

/// Roughly how large the log may grow before we truncate it on the next launch.
/// One service over a long Sunday is comfortably under this; we just don't want
/// it growing without bound across months of daily use.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Initialise the global logger to write to `path`. Idempotent: a second call is
/// ignored. Truncates the file first if it has grown past `MAX_LOG_BYTES`.
pub fn init(path: PathBuf) {
    if SINK.get().is_some() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Truncate an oversized log so it can't grow unbounded; otherwise append.
    let oversized = std::fs::metadata(&path)
        .map(|m| m.len() > MAX_LOG_BYTES)
        .unwrap_or(false);
    let file = OpenOptions::new()
        .create(true)
        .append(!oversized)
        .write(true)
        .truncate(oversized)
        .open(&path);
    if let Ok(file) = file {
        let _ = SINK.set(Mutex::new(Sink { path, file }));
        write(
            "INFO ",
            &format!(
                "==== StagePal {} session start ====",
                env!("CARGO_PKG_VERSION")
            ),
        );
    }
}

/// Absolute path of the active log file, if logging was initialised.
pub fn log_path() -> Option<PathBuf> {
    SINK.get().map(|m| m.lock().unwrap().path.clone())
}

/// Return up to the last `max_bytes` of the log as text (for the in-app viewer).
pub fn read_tail(max_bytes: usize) -> String {
    let Some(sink) = SINK.get() else {
        return "(logging not initialised)".to_string();
    };
    let path = sink.lock().unwrap().path.clone();
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => return format!("(could not open log: {e})"),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return "(could not seek log)".to_string();
    }
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);
    if start > 0 {
        // We sliced mid-file; drop the partial first line and flag the cut.
        if let Some(nl) = buf.find('\n') {
            buf = buf[nl + 1..].to_string();
        }
        format!("…(earlier log truncated)…\n{buf}")
    } else {
        buf
    }
}

/// Append one line at `level` (a fixed-width tag like "INFO "). Best-effort;
/// also mirrored to stderr so `tauri dev` still shows it inline.
pub fn write(level: &str, msg: &str) {
    let line = format!("[{}] {level} {msg}", timestamp(now_unix_ms()));
    eprintln!("{line}");
    if let Some(sink) = SINK.get() {
        if let Ok(mut s) = sink.lock() {
            let _ = writeln!(s.file, "{line}");
            let _ = s.file.flush();
        }
    }
}

/// Format unix-epoch millis as `YYYY-MM-DD HH:MM:SS.mmm` in UTC. Hand-rolled so
/// the logger needs no date crate. UTC keeps it unambiguous in shared logs.
fn timestamp(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Days-since-Unix-epoch → (year, month, day), UTC. Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + i64::from(m <= 2), m, d)
}

/// `format!`-style logging macros. Defined here so `$crate::logging::write`
/// resolves regardless of which module calls them.
#[macro_export]
macro_rules! linfo {
    ($($arg:tt)*) => { $crate::logging::write("INFO ", &format!($($arg)*)) };
}
#[macro_export]
macro_rules! lwarn {
    ($($arg:tt)*) => { $crate::logging::write("WARN ", &format!($($arg)*)) };
}
#[macro_export]
macro_rules! lerror {
    ($($arg:tt)*) => { $crate::logging::write("ERROR", &format!($($arg)*)) };
}
