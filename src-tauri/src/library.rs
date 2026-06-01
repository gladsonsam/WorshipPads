//! Scans a folder of pad audio files and maps them to musical keys.
//!
//! Recognises common worship-pad naming: "C.mp3", "C#.wav", "C Pad.mp3",
//! "Pad C.flac", "01 - C.mp3". Matching is by whole filename token, so a token
//! must be exactly a key spelling (sharp or flat).
//!
//! Two situations need human help, and both feed the conflict-resolution UI:
//!   - a file whose key can't be determined at all, and
//!   - two or more files that claim the *same* key (a conflict).
//!
//! In both cases the affected files land in `Preset::unmapped` rather than being
//! silently dropped, so the user can assign them to a key by hand.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::model::{Key, Preset};

const AUDIO_EXTS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a", "aac"];

fn has_audio_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Split a filename stem into tokens and return the first that names a key.
fn key_from_filename(path: &Path) -> Option<Key> {
    let stem = path.file_stem()?.to_str()?.to_lowercase();
    stem.split(|c: char| !(c.is_ascii_alphanumeric() || c == '#'))
        .filter(|t| !t.is_empty())
        .find_map(Key::parse)
}

/// List the audio files in `folder`, sorted, returning a friendly error if the
/// folder can't be read.
fn audio_files(folder: &Path) -> Result<Vec<PathBuf>, String> {
    if !folder.is_dir() {
        return Err(format!("not a folder: {}", folder.display()));
    }
    let mut paths: Vec<PathBuf> = std::fs::read_dir(folder)
        .map_err(|e| format!("read folder: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && has_audio_ext(p))
        .collect();
    paths.sort();
    Ok(paths)
}

fn folder_display_name(folder: &Path) -> String {
    folder
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Preset")
        .to_string()
}

/// Scan `folder`, auto-mapping confidently-named files to keys. A key claimed by
/// exactly one file is auto-assigned; anything ambiguous (no key, or a same-key
/// conflict) goes to `unmapped` for manual resolution. `name` overrides the
/// display name (defaults to the folder name).
pub fn scan_preset(folder: &Path, name: Option<String>) -> Result<Preset, String> {
    let paths = audio_files(folder)?;

    // Group every candidate file by the key its name implies.
    let mut by_key: HashMap<Key, Vec<PathBuf>> = HashMap::new();
    let mut unmapped: Vec<PathBuf> = Vec::new();
    for path in paths {
        match key_from_filename(&path) {
            Some(key) => by_key.entry(key).or_default().push(path),
            None => unmapped.push(path),
        }
    }

    // A key with one claimant is auto-assigned; conflicts go to `unmapped` so the
    // user resolves them explicitly rather than us guessing.
    let mut files: HashMap<Key, PathBuf> = HashMap::new();
    for (key, mut candidates) in by_key {
        if candidates.len() == 1 {
            files.insert(key, candidates.pop().unwrap());
        } else {
            unmapped.extend(candidates);
        }
    }
    unmapped.sort();

    Ok(Preset {
        id: folder.to_string_lossy().to_string(),
        name: name.unwrap_or_else(|| folder_display_name(folder)),
        folder: folder.to_path_buf(),
        files,
        unmapped,
    })
}

/// Re-scan an existing preset's folder, preserving the manual key assignments the
/// user has already made. Manual choices win; only files that still exist on disk
/// are kept, and anything new-but-ambiguous lands in `unmapped`.
pub fn rescan_preserving(old: &Preset, name: Option<String>) -> Result<Preset, String> {
    let fresh = scan_preset(&old.folder, name.or_else(|| Some(old.name.clone())))?;

    // The full set of audio files currently on disk.
    let universe: Vec<PathBuf> = fresh
        .files
        .values()
        .cloned()
        .chain(fresh.unmapped.iter().cloned())
        .collect();

    // Start from the fresh auto-mapping, then let surviving manual choices override.
    let mut files = fresh.files;
    for (key, path) in &old.files {
        if universe.contains(path) {
            files.insert(*key, path.clone());
        }
    }

    // Whatever isn't assigned to a key is unmapped.
    let mut unmapped: Vec<PathBuf> = universe
        .into_iter()
        .filter(|p| !files.values().any(|v| v == p))
        .collect();
    unmapped.sort();
    unmapped.dedup();

    Ok(Preset {
        unmapped,
        files,
        ..fresh
    })
}
