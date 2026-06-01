import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ALL_KEYS,
  assignKey,
  clearKey,
  getServerUrl,
  getSettings,
  getState,
  listAudioDevices,
  onNowPlaying,
  playKey,
  removePreset,
  renamePreset,
  scanLibrary,
  setAudioOutput,
  setClickAccent,
  setClickBeats,
  setClickBpm,
  setClickChannels,
  setClickEnabled,
  setClickVolume,
  setCrossfade,
  setCueChannels,
  setCueDuckClick,
  setPreset,
  setVolume,
  stopPads,
  type DeviceInfo,
  type Key,
  type NowPlaying,
  type Preset,
  type ServerUrl,
  type Settings,
} from "./lib/ipc";
import { CuesPage } from "./components/CuesPage";
import {
  BeatDots,
  BpmDisplay,
  Card,
  Eyebrow,
  Icon,
  Mark,
  Meter,
  NOTES,
  PadCluster,
  SelectField,
  Segmented,
  Slider,
  TapButton,
  Volume,
  type IconName,
  type Note,
  type PadStyle,
} from "./components/ui";
import "./App.css";

/** Just the file name from a full path (handles both separators). */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const PAD_STYLE_KEY = "worshippads.padStyle";
const PAGE_KEY = "worshippads.page";

type Page = "pads" | "click" | "cues" | "library" | "settings";
const PAGES: Page[] = ["pads", "click", "cues", "library", "settings"];

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [server, setServer] = useState<ServerUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem(PAGE_KEY);
    return PAGES.includes(saved as Page) ? (saved as Page) : "pads";
  });
  const [padStyle, setPadStyle] = useState<PadStyle>(
    () => (localStorage.getItem(PAD_STYLE_KEY) as PadStyle) || "grid",
  );

  function navigate(p: Page) {
    setPage(p);
    localStorage.setItem(PAGE_KEY, p);
  }
  function changePadStyle(v: PadStyle) {
    setPadStyle(v);
    localStorage.setItem(PAD_STYLE_KEY, v);
  }

  async function refreshSettings() {
    setSettings(await getSettings());
  }

  useEffect(() => {
    (async () => {
      try {
        setDevices(await listAudioDevices());
        setSettings(await getSettings());
        setNow(await getState());
        setServer(await getServerUrl());
      } catch (e) {
        setError(String(e));
      }
    })();
    const unlisten = onNowPlaying(setNow);
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  // Keyboard: Space toggles click globally as long as no text input is focused
  // so editing a bank name (etc.) isn't hijacked. Useful from any page.
  useEffect(() => {
    function isTextTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.repeat || isTextTarget(document.activeElement)) return;
      if (e.code === "Space") {
        e.preventDefault();
        const next = !(now?.click?.enabled ?? false);
        setClickEnabled(next).catch((err) => setError(String(err)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [now?.click?.enabled]);

  const activePreset = useMemo(
    () => settings?.presets.find((p) => p.id === settings.active_preset) ?? null,
    [settings],
  );

  const assignments = useMemo<Partial<Record<Note, string>>>(() => {
    const out: Partial<Record<Note, string>> = {};
    for (const [k, path] of Object.entries(activePreset?.files ?? {})) {
      if (path) out[k as Note] = baseName(path);
    }
    return out;
  }, [activePreset]);

  const selectedDevice = devices.find(
    (d) => d.name === settings?.output_device && d.host === settings?.output_host,
  );
  const channelCount = selectedDevice?.channels ?? 2;

  async function guard(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseFolder() {
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder === "string") {
      await guard(async () => {
        await scanLibrary(folder);
        await refreshSettings();
      });
    }
  }

  const phoneUrl = server
    ? server.ip
      ? `http://${server.ip}:${server.port}`
      : `http://${server.host}.local:${server.port}`
    : "";
  const phoneAddr = server
    ? server.ip
      ? `${server.ip}:${server.port}`
      : `${server.host}.local:${server.port}`
    : "";

  if (!settings) {
    return (
      <div className="app">
        <div className="boot">
          <Mark size={52} />
          <p>Starting the pad server… {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <Mark size={42} />
        <div className="app-title">Worship Pads</div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => setConnectOpen(true)}>
          <Icon name="phone" size={16} stroke="var(--text-2)" /> Connect phone
        </button>
      </header>

      <div className="app-shell">
        <nav className="sidebar" aria-label="Main navigation">
          <NavItem icon="grid" label="Pads" active={page === "pads"} onClick={() => navigate("pads")} />
          <NavItem icon="metronome" label="Click" active={page === "click"} onClick={() => navigate("click")} />
          <NavItem icon="mic" label="Cues" active={page === "cues"} onClick={() => navigate("cues")} />
          <NavItem icon="folder" label="Library" active={page === "library"} onClick={() => navigate("library")} />
          <NavItem icon="sliders" label="Settings" active={page === "settings"} onClick={() => navigate("settings")} />
        </nav>

        <main className="page">
          {error && <div className="error-banner">{error}</div>}

          {page === "pads" && (
            <PadsPage
              settings={settings}
              now={now}
              padStyle={padStyle}
              onPadStyleChange={changePadStyle}
              activePreset={activePreset}
              assignments={assignments}
              guard={guard}
              onGoLibrary={() => navigate("library")}
            />
          )}
          {page === "click" && (
            <ClickPage
              settings={settings}
              click={now?.click ?? null}
              guard={guard}
            />
          )}
          {page === "cues" && (
            <CuesPage
              settings={settings}
              speaking={!!now?.cue?.speaking}
              speakingLabel={now?.cue?.label ?? null}
              guard={guard}
              refreshSettings={refreshSettings}
            />
          )}
          {page === "library" && (
            <LibraryPage
              settings={settings}
              onAddFolder={chooseFolder}
              guard={guard}
              refreshSettings={refreshSettings}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              settings={settings}
              devices={devices}
              channelCount={channelCount}
              guard={guard}
              refreshSettings={refreshSettings}
            />
          )}
        </main>
      </div>

      {connectOpen && (
        <ConnectModal url={phoneUrl} addr={phoneAddr} server={server} onClose={() => setConnectOpen(false)} />
      )}
    </div>
  );
}

/* ─────────────────────────── sidebar nav ──────────────────────────── */
function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item${active ? " on" : ""}`} onClick={onClick}>
      <Icon
        name={icon}
        size={17}
        stroke={active ? "var(--accent-ink)" : "var(--text-3)"}
      />
      <span>{label}</span>
    </button>
  );
}

/* ─────────────────────────── pads page ────────────────────────────── */
function PadsPage({
  settings,
  now,
  padStyle,
  onPadStyleChange,
  activePreset,
  assignments,
  guard,
  onGoLibrary,
}: {
  settings: Settings;
  now: NowPlaying | null;
  padStyle: PadStyle;
  onPadStyleChange: (v: PadStyle) => void;
  activePreset: Preset | null;
  assignments: Partial<Record<Note, string>>;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  onGoLibrary: () => void;
}) {
  const playing = !!now?.playing;
  const playingKey = playing ? ((now?.key ?? null) as Note | null) : null;
  const liveVolume = Math.round((now?.volume ?? settings.master_volume) * 100);
  const mappedCount = Object.keys(assignments).length;

  return (
    <Card pad={28} style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 13, minWidth: 0 }}>
          <span
            className="display"
            style={{ fontSize: 26, lineHeight: 1, whiteSpace: "nowrap" }}
          >
            {activePreset ? activePreset.name : "No bank selected"}
          </span>
          {activePreset && (
            <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>
              {mappedCount} / 12 keys
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Segmented<PadStyle>
            value={padStyle}
            onChange={onPadStyleChange}
            options={[
              { key: "grid", label: "Grid", icon: "grid" },
              { key: "piano", label: "Piano", icon: "piano" },
            ]}
          />
          <Meter live={playing} h={26} />
        </div>
      </div>

      {activePreset ? (
        <div style={{ marginTop: 24, marginBottom: 4 }}>
          <PadCluster
            variant={padStyle}
            playing={playingKey}
            assignments={assignments}
            cols={6}
            h={88}
            big
            onTrigger={(n) => guard(() => playKey(n as Key))}
          />
        </div>
      ) : (
        <div className="pads-empty">
          <p>Pick or add a bank in the Library to start playing.</p>
          <button className="btn btn-accent" onClick={onGoLibrary}>
            <Icon name="folder" size={15} stroke="var(--on-accent)" /> Open library
          </button>
        </div>
      )}

      <div
        style={{
          marginTop: "auto",
          paddingTop: 30,
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <Volume
          value={liveVolume}
          big
          onChange={(v) => guard(() => setVolume(v / 100))}
        />
        <button
          className="btn btn-danger"
          disabled={!playing}
          onClick={() => guard(() => stopPads())}
        >
          <Icon name="power" size={16} stroke="var(--danger)" /> Stop / Fade
        </button>
      </div>
    </Card>
  );
}

/* ─────────────────────────── click page ───────────────────────────── */
function ClickPage({
  settings,
  click,
  guard,
}: {
  settings: Settings;
  click: NowPlaying["click"] | null;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const enabled = click?.enabled ?? false;
  const bpm = Math.round(click?.bpm ?? settings.click.bpm);
  const beats = click?.beats_per_bar ?? settings.click.beats_per_bar;
  const startedAt = click?.started_at_ms ?? null;
  const volumePct = Math.round((click?.volume ?? settings.click.volume) * 100);

  return (
    <Card pad={28} style={{ maxWidth: 520, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
        <Icon name="metronome" size={17} stroke="var(--accent-ink)" />
        <Eyebrow style={{ letterSpacing: "0.1em" }}>Click</Eyebrow>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
          Space = start/stop
        </span>
      </div>

      <BpmDisplay value={bpm} onChange={(v) => guard(() => setClickBpm(v))} />

      <BeatDots
        beatsPerBar={beats}
        bpm={bpm}
        startedAtMs={enabled ? startedAt : null}
      />

      <div className="click-row" style={{ justifyContent: "center", marginTop: 6 }}>
        <Segmented<string>
          value={String(beats)}
          onChange={(v) => guard(() => setClickBeats(Number(v)))}
          options={[
            { key: "3", label: "3/4" },
            { key: "4", label: "4/4" },
            { key: "6", label: "6/8" },
          ]}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <TapButton big onTap={(v) => guard(() => setClickBpm(v))} />
      </div>

      <div className="click-row" style={{ marginTop: 20 }}>
        <Icon name="speaker" size={17} stroke="var(--text-3)" />
        <Slider
          value={volumePct}
          min={0}
          max={100}
          onChange={(v) => guard(() => setClickVolume(v / 100))}
        />
        <div className="vol-num">{volumePct}</div>
      </div>

      <div className="click-row" style={{ marginTop: 16, justifyContent: "space-between" }}>
        <label className="click-toggle">
          <input
            type="checkbox"
            checked={click?.accent ?? settings.click.accent}
            onChange={(e) => guard(() => setClickAccent(e.target.checked))}
          />
          Accent on beat 1
        </label>
        <button
          className={enabled ? "btn btn-danger" : "btn btn-accent"}
          onClick={() => guard(() => setClickEnabled(!enabled))}
        >
          <Icon
            name={enabled ? "stop" : "play"}
            size={14}
            stroke={enabled ? "var(--danger)" : "var(--on-accent)"}
          />
          {enabled ? "Stop click" : "Start click"}
        </button>
      </div>

      <p className="helper-note" style={{ marginTop: 18 }}>
        Choose which output channels carry the click in Settings.
      </p>
    </Card>
  );
}

/* ─────────────────────────── library page ─────────────────────────── */
function LibraryPage({
  settings,
  onAddFolder,
  guard,
  refreshSettings,
}: {
  settings: Settings;
  onAddFolder: () => Promise<void> | void;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  refreshSettings: () => Promise<void>;
}) {
  return (
    <Card pad={24}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
        <Icon name="folder" size={17} stroke="var(--accent-ink)" />
        <Eyebrow style={{ letterSpacing: "0.1em" }}>Pad library</Eyebrow>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={onAddFolder}>
          <Icon name="plus" size={15} stroke="var(--text-2)" /> Add pad folder
        </button>
      </div>

      {settings.presets.length === 0 ? (
        <p className="empty-note">
          No pads yet. Add a folder of audio files — keys are detected from the file names
          (e.g. <code>C.wav</code>, <code>F# Pad.mp3</code>).
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {settings.presets.map((p) => (
            <Bank
              key={p.id}
              preset={p}
              active={p.id === settings.active_preset}
              onActivate={() =>
                guard(async () => {
                  await setPreset(p.id);
                  await refreshSettings();
                })
              }
              onRemove={() =>
                guard(async () => {
                  await removePreset(p.id);
                  await refreshSettings();
                })
              }
              onRename={(name) =>
                guard(async () => {
                  await renamePreset(p.id, name);
                  await refreshSettings();
                })
              }
              onAssign={(key, path) =>
                guard(async () => {
                  await assignKey(p.id, key, path);
                  await refreshSettings();
                })
              }
              onClear={(key) =>
                guard(async () => {
                  await clearKey(p.id, key);
                  await refreshSettings();
                })
              }
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ─────────────────────────── settings page ────────────────────────── */
function SettingsPage({
  settings,
  devices,
  channelCount,
  guard,
  refreshSettings,
}: {
  settings: Settings;
  devices: DeviceInfo[];
  channelCount: number;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  refreshSettings: () => Promise<void>;
}) {
  // Stable composite value so the device dropdown can disambiguate same-named
  // drivers that exist on both WASAPI and ASIO (e.g. some USB interfaces).
  const DEVICE_SEP = "|>|";
  const deviceKey = (host: string, name: string): string => host + DEVICE_SEP + name;
  const splitDeviceKey = (key: string): [string, string] => {
    const i = key.indexOf(DEVICE_SEP);
    return i < 0 ? ["WASAPI", key] : [key.slice(0, i), key.slice(i + DEVICE_SEP.length)];
  };

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
    </div>
  );
}

/* ─────────────────────────── routing picker ───────────────────────── */
function RoutingPicker({
  channelCount,
  channelLeft,
  channelRight,
  onChange,
}: {
  channelCount: number;
  channelLeft: number;
  channelRight: number;
  onChange: (left: number, right: number) => void;
}) {
  const isMono = channelLeft === channelRight;
  const opts = Array.from({ length: Math.max(1, channelCount) }, (_, i) => ({
    value: String(i),
    label: String(i + 1),
  }));

  function toMode(mode: "stereo" | "mono") {
    if (mode === "mono") {
      onChange(channelLeft, channelLeft);
    } else {
      // Pick a sensible R that differs from L. Prefer L+1; fall back to L-1
      // when L is already on the last channel of the device.
      let r = channelLeft + 1;
      if (r >= channelCount) r = Math.max(0, channelLeft - 1);
      if (r === channelLeft) r = channelLeft; // 1-channel device: no real stereo
      onChange(channelLeft, r);
    }
  }

  return (
    <div>
      <div className="routing-head">
        <Eyebrow style={{ letterSpacing: "0.08em" }}>Mode</Eyebrow>
        <Segmented<"stereo" | "mono">
          value={isMono ? "mono" : "stereo"}
          onChange={toMode}
          options={[
            { key: "stereo", label: "Stereo" },
            { key: "mono", label: "Mono" },
          ]}
        />
      </div>

      {isMono ? (
        <SelectField
          label="Channel"
          mono
          style={{ marginTop: 10 }}
          value={String(channelLeft)}
          options={opts}
          onChange={(v) => onChange(Number(v), Number(v))}
        />
      ) : (
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          <SelectField
            label="Left → ch"
            mono
            style={{ width: "50%" }}
            value={String(channelLeft)}
            options={opts}
            onChange={(v) => onChange(Number(v), channelRight)}
          />
          <SelectField
            label="Right → ch"
            mono
            style={{ width: "50%" }}
            value={String(channelRight)}
            options={opts}
            onChange={(v) => onChange(channelLeft, Number(v))}
          />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── pad-library bank ─────────────────────── */
function Bank({
  preset,
  active,
  onActivate,
  onRemove,
  onRename,
  onAssign,
  onClear,
}: {
  preset: Preset;
  active: boolean;
  onActivate: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onAssign: (key: Key, path: string) => void;
  onClear: (key: Key) => void;
}) {
  const [open, setOpen] = useState(active);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preset.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const files = preset.files;
  const count = Object.keys(files).length;
  const unmapped = preset.unmapped ?? [];

  function commitName() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== preset.name) onRename(name);
    else setDraft(preset.name);
  }

  return (
    <div className="bank">
      <div className={`bank-head${open ? " open" : ""}`}>
        <button
          className={`bank-dot${active ? " on" : ""}`}
          title={active ? "Active bank" : "Make active"}
          onClick={onActivate}
        />
        {editing ? (
          <input
            ref={inputRef}
            className="bank-name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setDraft(preset.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button className="bank-name" onDoubleClick={() => setEditing(true)} onClick={onActivate}>
            {preset.name}
          </button>
        )}
        <span className={`bank-pill${count === 12 ? " full" : ""}`}>{count}/12 keys</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="icon-btn" title="Rename" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={15} stroke="var(--text-2)" />
          </button>
          <button className="icon-btn" title="Remove" onClick={onRemove}>
            <Icon name="trash" size={15} stroke="var(--text-2)" />
          </button>
        </div>
        <button
          className="bank-chevron"
          title={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? "chevron" : "chevronR"} size={16} stroke="var(--text-3)" />
        </button>
      </div>

      {open && (
        <div className="bank-body">
          <div className="slot-grid">
            {NOTES.map((n) => {
              const path = files[n];
              return (
                <div key={n} className={`slot${path ? "" : " empty"}`}>
                  <span className="slot-key">{n}</span>
                  <span className="slot-file" title={path}>
                    {path ? baseName(path) : "empty"}
                  </span>
                  {path && (
                    <button
                      className="slot-clear"
                      title="Unmap this key"
                      onClick={() => onClear(n as Key)}
                    >
                      <Icon name="x" size={13} stroke="currentColor" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {unmapped.length > 0 && (
            <div className="resolver">
              <div className="resolver-head">
                <strong>
                  {unmapped.length} file{unmapped.length > 1 ? "s" : ""} need a key.
                </strong>{" "}
                The filename didn't match — assign each one.
              </div>
              {unmapped.map((path) => (
                <div key={path} className="resolver-row">
                  <Icon name="waves" size={16} stroke="var(--text-3)" />
                  <span className="resolver-file" title={path}>
                    {baseName(path)}
                  </span>
                  <SelectField
                    style={{ width: 150 }}
                    value=""
                    placeholder="Assign to…"
                    options={ALL_KEYS.map((k) => ({
                      value: k,
                      label: files[k] ? `${k} (replace)` : k,
                    }))}
                    onChange={(v) => onAssign(v as Key, path)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── connect-phone modal ──────────────────── */
function ConnectModal({
  url,
  addr,
  server,
  onClose,
}: {
  url: string;
  addr: string;
  server: ServerUrl | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Connect your phone">
        <button className="icon-btn" style={{ position: "absolute", top: 16, right: 16 }} title="Close" onClick={onClose}>
          <Icon name="x" size={15} stroke="var(--text-3)" />
        </button>

        <div className="modal-icon">
          <Icon name="wifi" size={22} stroke="var(--accent-ink)" />
        </div>
        <div className="modal-title">Connect your phone</div>
        <p className="modal-sub">
          Scan the code, or open the address in any browser on the same Wi-Fi.
        </p>

        <div className="qr">
          {url ? (
            <QRCodeSVG
              value={url}
              size={148}
              bgColor="transparent"
              fgColor="var(--text)"
              level="M"
            />
          ) : (
            <span className="mini-label">finding address…</span>
          )}
        </div>

        <div className="addr-pill">
          <span className="addr">{addr || "…"}</span>
          <button className="icon-btn" style={{ width: 38, height: 38 }} title="Copy" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={16} stroke="var(--text-2)" />
          </button>
        </div>
        {server?.ip && (
          <div className="addr-sub">
            or {server.host}.local:{server.port}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
