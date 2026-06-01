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
  setCrossfade,
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
import {
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
  Volume,
  type Note,
  type PadStyle,
} from "./components/ui";
import "./App.css";

/** Just the file name from a full path (handles both separators). */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const PAD_STYLE_KEY = "worshippads.padStyle";

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [server, setServer] = useState<ServerUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [padStyle, setPadStyle] = useState<PadStyle>(
    () => (localStorage.getItem(PAD_STYLE_KEY) as PadStyle) || "grid",
  );

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
  /** Stable composite value so the device dropdown can disambiguate same-named
   * drivers that exist on both WASAPI and ASIO (e.g. some USB interfaces). */
  const DEVICE_SEP = "|>|";
  const deviceKey = (host: string, name: string): string => host + DEVICE_SEP + name;
  const splitDeviceKey = (key: string): [string, string] => {
    const i = key.indexOf(DEVICE_SEP);
    return i < 0 ? ["WASAPI", key] : [key.slice(0, i), key.slice(i + DEVICE_SEP.length)];
  };

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

  const playing = !!now?.playing;
  const playingKey = playing ? ((now?.key ?? null) as Note | null) : null;
  const liveVolume = Math.round((now?.volume ?? settings.master_volume) * 100);
  const mappedCount = Object.keys(assignments).length;

  return (
    <div className="app">
      <div className="app-body">
        {/* header */}
        <header className="app-header">
          <Mark size={42} />
          <div className="app-title">Worship Pads</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => setConnectOpen(true)}>
            <Icon name="phone" size={16} stroke="var(--text-2)" /> Connect phone
          </button>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {/* main two-column grid */}
        <div className="grid-main">
          {/* NOW PLAYING */}
          <Card pad={26} style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 13, minWidth: 0 }}>
                <span
                  className="display"
                  style={{ fontSize: 24, lineHeight: 1, whiteSpace: "nowrap" }}
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
                  onChange={changePadStyle}
                  options={[
                    { key: "grid", label: "Grid", icon: "grid" },
                    { key: "piano", label: "Piano", icon: "piano" },
                  ]}
                />
                <Meter live={playing} h={26} />
              </div>
            </div>

            <div style={{ marginTop: 20, marginBottom: 4 }}>
              <PadCluster
                variant={padStyle}
                playing={playingKey}
                assignments={assignments}
                cols={6}
                h={74}
                onTrigger={(n) => guard(() => playKey(n as Key))}
              />
            </div>

            <div
              style={{
                marginTop: "auto",
                paddingTop: 26,
                display: "flex",
                alignItems: "center",
                gap: 18,
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

          {/* AUDIO OUTPUT */}
          <Card pad={22}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
              <Icon name="sliders" size={17} stroke="var(--accent-ink)" />
              <Eyebrow style={{ letterSpacing: "0.1em" }}>Audio output</Eyebrow>
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
                  // Reset routing to 1/2 on switch — channel indexes from the
                  // previous device may not exist on the new one.
                  await setAudioOutput(host, name, 0, 1);
                  await refreshSettings();
                })
              }
            />

            <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
              <SelectField
                label="Left → ch"
                mono
                style={{ width: "50%" }}
                value={String(settings.channel_left)}
                options={Array.from({ length: channelCount }, (_, i) => ({
                  value: String(i),
                  label: String(i + 1),
                }))}
                onChange={(v) =>
                  guard(async () => {
                    await setAudioOutput(
                      settings.output_host,
                      settings.output_device ?? "",
                      Number(v),
                      settings.channel_right,
                    );
                    await refreshSettings();
                  })
                }
              />
              <SelectField
                label="Right → ch"
                mono
                style={{ width: "50%" }}
                value={String(settings.channel_right)}
                options={Array.from({ length: channelCount }, (_, i) => ({
                  value: String(i),
                  label: String(i + 1),
                }))}
                onChange={(v) =>
                  guard(async () => {
                    await setAudioOutput(
                      settings.output_host,
                      settings.output_device ?? "",
                      settings.channel_left,
                      Number(v),
                    );
                    await refreshSettings();
                  })
                }
              />
            </div>

            <div style={{ marginTop: 16 }}>
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
              Map the stereo pair to the output channels your pads should play on — e.g. a spare
              pair on your interface, to keep them off your main mix.
            </p>
          </Card>
        </div>

        {/* PAD LIBRARY */}
        <Card pad={22}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
            <Icon name="folder" size={17} stroke="var(--accent-ink)" />
            <Eyebrow style={{ letterSpacing: "0.1em" }}>Pad library</Eyebrow>
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost" onClick={chooseFolder}>
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
      </div>

      {connectOpen && (
        <ConnectModal url={phoneUrl} addr={phoneAddr} server={server} onClose={() => setConnectOpen(false)} />
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
