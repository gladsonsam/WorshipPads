// Settings page — output device, three bus routings (pad/click/cue),
// crossfade duration, and the duck-click toggle. Each card is a self-contained
// concern; adding a fourth bus is one more card.

import { useState } from "react";
import {
  audioDiagnostics,
  getLogPath,
  readLog,
  setAudioOutput,
  setClickChannels,
  setCrossfade,
  setCueChannels,
  setCueDuckClick,
  type ActiveOutput,
  type DeviceInfo,
  type Settings,
} from "../lib/ipc";
import { Card, Eyebrow, Icon, SelectField, Slider } from "./ui";
import { RoutingPicker } from "./RoutingPicker";

interface Props {
  settings: Settings;
  devices: DeviceInfo[];
  channelCount: number;
  activeOutput: ActiveOutput | null;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  refreshSettings: () => Promise<void>;
}

// Stable composite value so the device dropdown can disambiguate same-named
// drivers that exist on both WASAPI and ASIO (e.g. some USB interfaces).
const DEVICE_SEP = "|>|";
const deviceKey = (host: string, name: string): string => host + DEVICE_SEP + name;
const splitDeviceKey = (key: string): [string, string] => {
  const i = key.indexOf(DEVICE_SEP);
  return i < 0 ? ["WASAPI", key] : [key.slice(0, i), key.slice(i + DEVICE_SEP.length)];
};

export function SettingsPage({
  settings,
  devices,
  channelCount,
  activeOutput,
  guard,
  refreshSettings,
}: Props) {
  const matchesSelected =
    activeOutput &&
    activeOutput.device === settings.output_device &&
    activeOutput.host === settings.output_host;

  const [diagText, setDiagText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  function flashCopied(what: string) {
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
  }

  async function runDiagnostics() {
    setBusy(true);
    try {
      setDiagText(await audioDiagnostics());
    } finally {
      setBusy(false);
    }
  }

  async function copyDiagnostics() {
    // Always capture a fresh report plus the log tail — that's the bundle that's
    // useful to send back when a device won't open.
    setBusy(true);
    try {
      const [report, log, path] = await Promise.all([
        audioDiagnostics(),
        readLog(),
        getLogPath(),
      ]);
      const bundle = `=== StagePal diagnostics ===\nlog: ${path ?? "(unknown)"}\n\n${report}\n\n=== recent log ===\n${log}`;
      setDiagText(report);
      await navigator.clipboard.writeText(bundle);
      flashCopied("report");
    } finally {
      setBusy(false);
    }
  }

  async function revealLog() {
    const path = await getLogPath();
    if (!path) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch {
      await navigator.clipboard.writeText(path);
      flashCopied("path");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <Card pad={22}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
          <Icon name="sliders" size={17} stroke="var(--accent-ink)" />
          <Eyebrow style={{ letterSpacing: "0.1em" }}>Output device</Eyebrow>
        </div>
        <SelectField
          label="Device"
          value={
            settings.output_device
              ? deviceKey(settings.output_host, settings.output_device)
              : ""
          }
          placeholder="Select a device…"
          options={devices.map((d) => ({
            value: deviceKey(d.host, d.name),
            label: `[${d.host}] ${d.name} · ${d.channels}ch @ ${Math.round(
              d.default_sample_rate / 1000,
            )} kHz${d.is_default ? " — default" : ""}`,
          }))}
          onChange={(v) =>
            guard(async () => {
              const [host, name] = splitDeviceKey(v);
              // Reset pad routing to 1/2 on switch — channel indexes from the
              // previous device may not exist on the new one.
              await setAudioOutput(host, name, 0, 1);
              await refreshSettings();
            })
          }
        />

        {settings.output_device ? (
          matchesSelected ? (
            <div className="output-status output-status--ok">
              <Icon name="waves" size={14} stroke="var(--accent-ink)" />
              <span>
                Open · {activeOutput!.channels} ch ·{" "}
                {Math.round(activeOutput!.sample_rate / 1000)} kHz ·{" "}
                {activeOutput!.sample_format}
                {activeOutput!.buffer_frames
                  ? ` · ${activeOutput!.buffer_frames}-frame buffer`
                  : ""}
              </span>
            </div>
          ) : (
            <div className="output-status output-status--warn">
              <span className="output-status-dot" aria-hidden />
              <span>
                Selected but not open — the device failed to start. See diagnostics below.
              </span>
            </div>
          )
        ) : null}
      </Card>

      <Card pad={22}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Icon name="waves" size={17} stroke="var(--accent-ink)" />
          <Eyebrow style={{ letterSpacing: "0.1em" }}>Pad output</Eyebrow>
        </div>

        <RoutingPicker
          channelCount={channelCount}
          channelLeft={settings.channel_left}
          channelRight={settings.channel_right}
          onChange={(l, r) =>
            guard(async () => {
              await setAudioOutput(
                settings.output_host,
                settings.output_device ?? "",
                l,
                r,
              );
              await refreshSettings();
            })
          }
        />

        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <Eyebrow style={{ letterSpacing: "0.08em" }}>Crossfade</Eyebrow>
            <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
              {(settings.crossfade_ms / 1000).toFixed(1)} s
            </span>
          </div>
          <Slider
            value={settings.crossfade_ms}
            min={200}
            max={8000}
            step={100}
            onChange={(ms) =>
              guard(async () => {
                await setCrossfade(ms);
                await refreshSettings();
              })
            }
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
            <span className="mini-label">Instant</span>
            <span className="mini-label">Slow fade</span>
          </div>
        </div>

        <p className="helper-note">
          Route the pads to a spare output pair on your interface so they don't land on
          your main mix.
        </p>
      </Card>

      <Card pad={22}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Icon name="metronome" size={17} stroke="var(--accent-ink)" />
          <Eyebrow style={{ letterSpacing: "0.1em" }}>Click output</Eyebrow>
        </div>

        <RoutingPicker
          channelCount={channelCount}
          channelLeft={settings.click.channel_left}
          channelRight={settings.click.channel_right}
          onChange={(l, r) =>
            guard(async () => {
              await setClickChannels(l, r);
              await refreshSettings();
            })
          }
        />

        <p className="helper-note">
          The click is mono. Use stereo only if your IEM bus expects a stereo pair —
          most click busses are mono.
        </p>
      </Card>

      <Card pad={22}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Icon name="mic" size={17} stroke="var(--accent-ink)" />
          <Eyebrow style={{ letterSpacing: "0.1em" }}>Cue output</Eyebrow>
        </div>

        <RoutingPicker
          channelCount={channelCount}
          channelLeft={settings.cues.channel_left}
          channelRight={settings.cues.channel_right}
          onChange={(l, r) =>
            guard(async () => {
              await setCueChannels(l, r);
              await refreshSettings();
            })
          }
        />

        <label className="click-toggle" style={{ marginTop: 16 }}>
          <input
            type="checkbox"
            checked={settings.cues.duck_click}
            onChange={(e) =>
              guard(async () => {
                await setCueDuckClick(e.target.checked);
                await refreshSettings();
              })
            }
          />
          Duck click while speaking
        </label>

        <p className="helper-note">
          Pick a spare output pair for spoken cues — they're meant for the band's IEMs,
          not the main mix. To share the click bus, point this at the same channels.
        </p>
      </Card>

      <Card pad={22}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Icon name="sliders" size={17} stroke="var(--accent-ink)" />
          <Eyebrow style={{ letterSpacing: "0.1em" }}>Audio diagnostics</Eyebrow>
        </div>

        <p className="helper-note" style={{ marginTop: 0 }}>
          If a device won't open (common with ASIO), run a probe of every audio
          interface on this machine. Copy the report — it includes the recent log —
          and send it over so the failure can be pinned down.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
          <button className="btn btn-ghost" disabled={busy} onClick={() => guard(runDiagnostics)}>
            {busy ? "Probing…" : "Run probe"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => guard(copyDiagnostics)}>
            <Icon name="copy" size={15} stroke="var(--text-2)" />{" "}
            {copied === "report" ? "Copied!" : "Copy report + log"}
          </button>
          <button className="btn btn-ghost" onClick={() => guard(revealLog)}>
            <Icon name="folder" size={15} stroke="var(--text-2)" />{" "}
            {copied === "path" ? "Path copied!" : "Open log folder"}
          </button>
        </div>

        {diagText && (
          <pre className="diag-output" aria-label="Audio diagnostics report">
            {diagText}
          </pre>
        )}
      </Card>
    </div>
  );
}
