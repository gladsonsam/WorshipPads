//! Core data types shared across the app: musical keys, pad presets, persisted
//! settings, and the live "now playing" state broadcast to all clients.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The 12 chromatic roots. Designed to extend later with major/minor quality.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    #[serde(rename = "C")]
    C,
    #[serde(rename = "C#")]
    Cs,
    #[serde(rename = "D")]
    D,
    #[serde(rename = "D#")]
    Ds,
    #[serde(rename = "E")]
    E,
    #[serde(rename = "F")]
    F,
    #[serde(rename = "F#")]
    Fs,
    #[serde(rename = "G")]
    G,
    #[serde(rename = "G#")]
    Gs,
    #[serde(rename = "A")]
    A,
    #[serde(rename = "A#")]
    As,
    #[serde(rename = "B")]
    B,
}

impl Key {
    pub const ALL: [Key; 12] = [
        Key::C,
        Key::Cs,
        Key::D,
        Key::Ds,
        Key::E,
        Key::F,
        Key::Fs,
        Key::G,
        Key::Gs,
        Key::A,
        Key::As,
        Key::B,
    ];

    /// Canonical display string, e.g. "C#".
    pub fn as_str(self) -> &'static str {
        match self {
            Key::C => "C",
            Key::Cs => "C#",
            Key::D => "D",
            Key::Ds => "D#",
            Key::E => "E",
            Key::F => "F",
            Key::Fs => "F#",
            Key::G => "G",
            Key::Gs => "G#",
            Key::A => "A",
            Key::As => "A#",
            Key::B => "B",
        }
    }

    /// Parse a key from an API/UI string (accepts sharps and flats).
    pub fn parse(s: &str) -> Option<Key> {
        let norm = s.trim().to_lowercase();
        Key::ALL.into_iter().find(|k| k.aliases().contains(&norm.as_str()))
    }

    /// Lowercase spellings used to recognise this key in a filename stem.
    /// Includes sharp, flat, and "sharp"/"flat" word forms.
    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            Key::C => &["c"],
            Key::Cs => &["c#", "cs", "csharp", "db", "dflat"],
            Key::D => &["d"],
            Key::Ds => &["d#", "ds", "dsharp", "eb", "eflat"],
            Key::E => &["e"],
            Key::F => &["f"],
            Key::Fs => &["f#", "fs", "fsharp", "gb", "gflat"],
            Key::G => &["g"],
            Key::Gs => &["g#", "gs", "gsharp", "ab", "aflat"],
            Key::A => &["a"],
            Key::As => &["a#", "as", "asharp", "bb", "bflat"],
            Key::B => &["b"],
        }
    }
}

/// A set of pad files (one per key) living in one folder.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub folder: PathBuf,
    /// Key → audio file path. May be missing some keys.
    pub files: HashMap<Key, PathBuf>,
    /// Audio files found in the folder whose key could not be determined
    /// automatically (or that lost a same-key conflict). Surfaced to the UI so
    /// the user can assign them to a key by hand. `#[serde(default)]` keeps old
    /// settings files (written before this field existed) loadable.
    #[serde(default)]
    pub unmapped: Vec<PathBuf>,
}

/// Persisted application settings.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// cpal host label ("WASAPI" or "ASIO"). Defaulted to WASAPI on Windows so
    /// older settings files (written before ASIO support) keep working.
    #[serde(default = "default_host")]
    pub output_host: String,
    pub output_device: Option<String>,
    pub channel_left: usize,
    pub channel_right: usize,
    pub crossfade_ms: u32,
    pub master_volume: f32,
    pub presets: Vec<Preset>,
    pub active_preset: Option<String>,
    pub server_port: u16,
}

fn default_host() -> String {
    "WASAPI".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            output_host: default_host(),
            output_device: None,
            channel_left: 0,
            channel_right: 1,
            crossfade_ms: 2000,
            master_volume: 0.8,
            presets: Vec::new(),
            active_preset: None,
            server_port: 7777,
        }
    }
}

impl Settings {
    pub fn active_preset(&self) -> Option<&Preset> {
        let id = self.active_preset.as_deref()?;
        self.presets.iter().find(|p| p.id == id)
    }
}

/// Live playback state, broadcast to every connected client (desktop + phones).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NowPlaying {
    pub key: Option<Key>,
    pub preset: Option<String>,
    pub volume: f32,
    pub playing: bool,
}

impl Default for NowPlaying {
    fn default() -> Self {
        NowPlaying {
            key: None,
            preset: None,
            volume: 0.8,
            playing: false,
        }
    }
}
