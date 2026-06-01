// Keeps `src-tauri/Cargo.toml` in step with `package.json`.
//
// Runs automatically as the npm `version` lifecycle hook — i.e. when you
// `npm version patch|minor|major`, npm bumps `package.json` first, then calls
// this script, then commits + tags. Cargo.toml ends up in the same commit as
// the version bump, so all three files (package.json, tauri.conf.json which
// already reads from package.json, and Cargo.toml) stay aligned.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const cargoPath = resolve(repoRoot, "src-tauri/Cargo.toml");
const cargo = await readFile(cargoPath, "utf8");

// Replace the first `version = "..."` line in [package]. This relies on the
// crate's own version being the first one in the file; build-deps versions
// come later as `something = { version = "..." }` and won't match.
const updated = cargo.replace(/^version = "[^"]+"$/m, `version = "${pkg.version}"`);
if (updated === cargo) {
  console.error("sync-cargo-version: no version line found in src-tauri/Cargo.toml");
  process.exit(1);
}

await writeFile(cargoPath, updated);
console.log(`sync-cargo-version: src-tauri/Cargo.toml -> ${pkg.version}`);
