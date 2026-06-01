//! Headless smoke test for the SAPI text-to-speech synthesizer.
//!   cargo run --example cue_smoke
//!
//! Lists installed voices and renders a short phrase to a WAV in the system
//! temp dir, printing its path. Open the WAV manually to verify it speaks.

use stagepal_lib::cues::{SapiSynth, Synthesizer};

fn main() {
    let synth = SapiSynth::new();

    match synth.voices() {
        Ok(v) if v.is_empty() => println!("(no SAPI voices installed)"),
        Ok(v) => {
            println!("voices ({}):", v.len());
            for vi in &v {
                println!("  - {}", vi.name);
            }
        }
        Err(e) => println!("voices failed: {e}"),
    }

    let out = std::env::temp_dir().join("stagepal-cue-smoke.wav");
    let text = "Verse two.";
    match synth.synth_to_wav(text, None, 0, &out) {
        Ok(()) => println!("wrote {} bytes -> {}", file_size(&out), out.display()),
        Err(e) => println!("synth failed: {e}"),
    }
}

fn file_size(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}
