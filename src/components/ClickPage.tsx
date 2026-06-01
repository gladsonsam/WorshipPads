// Click page — BPM, beat dots, tap tempo, volume, start/stop.

import {
  setClickAccent,
  setClickBeats,
  setClickBpm,
  setClickEnabled,
  setClickVolume,
  type NowPlaying,
  type Settings,
} from "../lib/ipc";
import {
  BeatDots,
  BpmDisplay,
  Card,
  Eyebrow,
  Icon,
  Segmented,
  Slider,
  TapButton,
} from "./ui";

interface Props {
  settings: Settings;
  click: NowPlaying["click"] | null;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
}

export function ClickPage({ settings, click, guard }: Props) {
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
