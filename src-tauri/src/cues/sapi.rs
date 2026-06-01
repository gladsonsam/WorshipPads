//! Windows SAPI implementation via PowerShell + System.Speech.Synthesis.
//!
//! Why PowerShell instead of binding SAPI's COM directly? Zero new Rust deps,
//! works on every stock Windows install (PowerShell + .NET are both shipped),
//! and the call shape is dead-simple to reason about. The trait abstraction
//! means we can swap to a `windows`-crate COM impl later without touching the
//! audio engine or commands.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use super::synth::{Synthesizer, VoiceInfo};

/// Generates collision-free temp filenames within a single process lifetime.
static SEQ: AtomicU64 = AtomicU64::new(0);

pub struct SapiSynth;

impl SapiSynth {
    pub fn new() -> Self {
        SapiSynth
    }
}

impl Default for SapiSynth {
    fn default() -> Self {
        SapiSynth::new()
    }
}

impl Synthesizer for SapiSynth {
    fn voices(&self) -> Result<Vec<VoiceInfo>, String> {
        // ConvertTo-Json + ASCII output keeps parsing trivial. `-Compress` so
        // the pipe stays single-line; ConvertTo-Json wraps a one-element array
        // as a bare object, so we coerce via @() before JSON encoding.
        let script = "Add-Type -AssemblyName System.Speech | Out-Null; \
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
            $voices = @($s.GetInstalledVoices() | ForEach-Object { \
                @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name } \
            }); \
            $s.Dispose(); \
            ConvertTo-Json -Compress -InputObject $voices";

        let out = run_ps(script)?;
        if out.trim().is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str::<Vec<VoiceInfo>>(out.trim())
            .map_err(|e| format!("parse voices: {e} (raw: {out:?})"))
    }

    fn synth_to_wav(
        &self,
        text: &str,
        voice: Option<&str>,
        rate: i32,
        out: &Path,
    ) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("nothing to speak".into());
        }

        // Pipe the text in via stdin to dodge every PowerShell quoting pitfall
        // (apostrophes, newlines, curly quotes, non-ASCII). The script reads
        // stdin in full and feeds it to Speak().
        let rate = rate.clamp(-10, 10);
        let out_path = ps_escape(&out.to_string_lossy());
        let voice_line = match voice {
            Some(v) if !v.trim().is_empty() => {
                format!("$s.SelectVoice('{}');", ps_escape(v))
            }
            _ => String::new(),
        };

        let script = format!(
            "Add-Type -AssemblyName System.Speech | Out-Null; \
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
            $s.Rate = {rate}; \
            {voice_line} \
            $s.SetOutputToWaveFile('{out_path}'); \
            $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8); \
            $text = $reader.ReadToEnd(); \
            $s.Speak($text); \
            $s.Dispose()"
        );

        run_ps_stdin(&script, text.as_bytes()).map(|_| ())
    }
}

/// Allocate a temp path for a freshly-rendered cue WAV. Caller is responsible
/// for deletion once playback is done.
pub fn temp_wav_path() -> std::path::PathBuf {
    let pid = std::process::id();
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("stagepal-cue-{pid}-{n}.wav"))
}

/// Escape a string for embedding inside a PowerShell single-quoted literal.
/// Inside '…' only the apostrophe itself is special — doubled to escape.
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Run a PowerShell script with no stdin and capture stdout. Errors carry
/// stderr text so a misconfigured SAPI install (missing voices, perms) shows
/// up in logs.
fn run_ps(script: &str) -> Result<String, String> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn powershell: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "powershell exited {} — {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Same as `run_ps` but writes `stdin_bytes` to the child's stdin. Used so
/// arbitrary user text never needs quoting on the command line.
fn run_ps_stdin(script: &str, stdin_bytes: &[u8]) -> Result<String, String> {
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn powershell: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_bytes)
            .map_err(|e| format!("write stdin: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("await powershell: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "powershell exited {} — {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
