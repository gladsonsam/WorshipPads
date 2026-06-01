//! Text-to-speech "cues" — quick spoken messages the band can fire from the
//! phone remote to communicate over IEMs without yelling across stage.
//!
//! `Synthesizer` is the abstraction; `SapiSynth` is the v1 Windows-only impl
//! built on `System.Speech.Synthesis` via PowerShell. Swapping for a direct
//! Win32/COM impl (or a macOS/Linux backend) is a matter of dropping in
//! another `Synthesizer` and selecting it at construction.

mod sapi;
mod synth;

pub use sapi::{temp_wav_path as sapi_temp_wav_path, SapiSynth};
pub use synth::{Synthesizer, VoiceInfo};
