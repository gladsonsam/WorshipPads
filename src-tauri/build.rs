use std::path::Path;

fn main() {
    ensure_remote_placeholder();
    tauri_build::build()
}

/// `src/server.rs` embeds `assets/remote.html` via `include_str!`, but that
/// file is a build artifact produced by `npm run build:remote` (from the React
/// source in `src/remote/`) and is intentionally not committed. Write a tiny
/// placeholder when it's missing so a bare `cargo build` / `cargo check` — and
/// rust-analyzer — work on a fresh clone before the frontend has been built.
///
/// The normal Tauri flow (`npm run tauri dev`, `npm run tauri build`) rebuilds
/// the real remote first via the `beforeDevCommand`/`beforeBuildCommand` hooks
/// in `tauri.conf.json`, overwriting this placeholder.
fn ensure_remote_placeholder() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/remote.html");
    if path.exists() {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        "<!doctype html><meta charset=\"utf-8\"><title>StagePal Remote</title>\
         <p>Remote UI not built yet. Run <code>npm run build:remote</code> \
         (or just <code>npm run tauri dev</code>) to generate it.</p>",
    );
}
