// REST + WebSocket transport to the Rust server (see src-tauri/src/server.rs).
// All POST endpoints are fire-and-forget — the server broadcasts the new state
// back over /ws, which the UI re-renders from.

import type { NowPlaying } from "../shared/types";

export interface PresetBrief {
  id: string;
  name: string;
}

export interface Info {
  keys: string[];
  presets: PresetBrief[];
  active_preset: string | null;
  mapped_keys: string[];
  /** Active preset's key → file name (basename only, for pad labels). */
  files: Record<string, string>;
  now: NowPlaying;
}

export function post(path: string, body?: unknown): Promise<void> {
  return fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
    .then(() => undefined)
    .catch(() => undefined);
}

export async function fetchInfo(): Promise<Info> {
  const r = await fetch("/api/info");
  return (await r.json()) as Info;
}
