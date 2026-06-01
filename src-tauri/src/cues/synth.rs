//! `Synthesizer` trait — the boundary between the rest of the app and whatever
//! TTS engine is in use. Implementations render arbitrary text into a WAV file
//! that the audio engine can then play through its normal voice/routing path,
//! so the audio engine doesn't need to know TTS exists.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One installed system voice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInfo {
    /// Identifier used by `synth_to_wav` to select this voice. For SAPI this
    /// is the voice's Name string (e.g. "Microsoft Zira Desktop").
    pub id: String,
    /// Friendly label for the UI. May equal `id`.
    pub name: String,
}

pub trait Synthesizer: Send + Sync {
    /// Enumerate the voices the user can pick from. May be empty if the
    /// platform has none installed.
    fn voices(&self) -> Result<Vec<VoiceInfo>, String>;

    /// Render `text` to `out` as a WAV file. `voice` of `None` means use the
    /// system default voice. `rate` is the SAPI-style rate scale, -10..10
    /// (0 = normal); impls may clamp to whatever range they support.
    ///
    /// Synchronous on purpose: callers are expected to spawn this on a worker
    /// thread (rendering can take ~100ms even for short text), so making the
    /// trait method itself async would force every impl into a runtime.
    fn synth_to_wav(
        &self,
        text: &str,
        voice: Option<&str>,
        rate: i32,
        out: &Path,
    ) -> Result<(), String>;
}
