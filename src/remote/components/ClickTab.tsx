import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../shared/types";
import { useHoldRepeat } from "../../shared/useHoldRepeat";
import { useTapTempo } from "../../shared/useTapTempo";
import { post } from "../api";
import { useServerClockOffset } from "../hooks/useServerClockOffset";
import { MinusIcon, PlusIcon, VolumeIcon } from "./icons";

const clampBpm = (v: number) => Math.max(30, Math.min(300, Math.round(v)));

interface Props {
  now: NowPlaying;
}

export function ClickTab({ now }: Props) {
  const bpm = Math.round(now.click?.bpm ?? 90);
  const beats = now.click?.beats_per_bar ?? 4;
  const enabled = !!now.click?.enabled;
  const clockOffset = useServerClockOffset();

  return (
    <section className="tab-body" role="tabpanel" aria-label="Click">
      <BpmBlock bpm={bpm} />

      <BeatDots
        beats={beats}
        bpm={now.click?.bpm ?? 90}
        startedAt={now.click?.started_at_ms ?? null}
        enabled={enabled}
        clockOffset={clockOffset}
      />

      <div className="ts-row">
        <div className="seg">
          {[3, 4, 6].map((n) => (
            <button
              key={n}
              type="button"
              className={beats === n ? "on" : ""}
              onClick={() => post("/api/click/beats", { beats: n })}
            >
              {n === 6 ? "6/8" : `${n}/4`}
            </button>
          ))}
        </div>
      </div>

      <TapButton />

      <ClickVolume value={now.click?.volume ?? 0.8} />

      <label className="click-accent">
        <span>Accent on beat 1</span>
        <input
          type="checkbox"
          checked={!!now.click?.accent}
          onChange={(e) => post("/api/click/accent", { accent: e.currentTarget.checked })}
        />
      </label>

      <button
        type="button"
        className={`transport ${enabled ? "click-live" : "idle"}`}
        style={{ marginTop: 16 }}
        onClick={() => post("/api/click/enabled", { enabled: !enabled })}
      >
        {enabled ? "■ Stop click" : "▶ Start click"}
      </button>
      <p className="hint">{enabled ? "Click is running." : ""}</p>
    </section>
  );
}

function BpmBlock({ bpm }: { bpm: number }) {
  const sendBpm = (v: number) => post("/api/click/bpm", { bpm: clampBpm(v) });
  const minusProps = useHoldRepeat(bpm, -1, sendBpm);
  const plusProps = useHoldRepeat(bpm, +1, sendBpm);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(String(bpm));
    setEditing(true);
  };
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && draft.trim() !== "") sendBpm(n);
    setEditing(false);
  };

  return (
    <div className="bpm-block">
      <button
        type="button"
        className="bpm-step"
        aria-label="Decrease BPM"
        {...minusProps}
      >
        <MinusIcon />
      </button>
      <div
        className="bpm-pill"
        onClick={editing ? undefined : startEdit}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            startEdit();
          }
        }}
        role="button"
        tabIndex={editing ? -1 : 0}
      >
        <span className="glyph">♩=</span>
        {editing ? (
          <input
            ref={inputRef}
            className="bpm-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft}
            onChange={(e) =>
              setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
            }
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="val">{bpm}</span>
        )}
      </div>
      <button
        type="button"
        className="bpm-step"
        aria-label="Increase BPM"
        {...plusProps}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/**
 * Beat dots that pulse on the active beat. Computed from the server-stamped
 * started_at_ms + local clock so playback indication doesn't rely on per-tick
 * WS frames. Uses setInterval (not RAF) so it keeps ticking in background tabs.
 *
 * `clockOffset` (server clock − device clock, in ms) is added to Date.now()
 * so phones whose wall clock drifts from the host don't show offset dots.
 *
 * The active dot is rendered into the JSX className (not poked onto the DOM
 * imperatively) so parent re-renders — which arrive on every WS frame — can't
 * momentarily wipe the highlight. The `.one` accent on beat 1 lives in the
 * same string, so it's always present too.
 */
function BeatDots({
  beats,
  bpm,
  startedAt,
  enabled,
  clockOffset,
}: {
  beats: number;
  bpm: number;
  startedAt: number | null;
  enabled: boolean;
  clockOffset: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !startedAt) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 50);
    return () => window.clearInterval(id);
  }, [enabled, startedAt]);

  const live = enabled && startedAt != null && bpm > 0;
  // ((x % n) + n) % n so a slightly-negative elapsed (device clock briefly
  // ahead of server, or clockOffset still settling) wraps cleanly to the
  // last dot instead of producing a negative index that matches nothing.
  const beatsN = Math.max(1, beats);
  const current = live
    ? ((Math.floor(((Date.now() + clockOffset - startedAt) * bpm) / 60_000) %
        beatsN) +
        beatsN) %
      beatsN
    : -1;

  return (
    <div className="beat-dots">
      {Array.from({ length: Math.max(1, beats) }).map((_, i) => (
        <span
          key={i}
          className={`dot${i === 0 ? " one" : ""}${i === current ? " on" : ""}`}
        />
      ))}
    </div>
  );
}

/** Tempo math lives in the shared useTapTempo hook (also used on desktop). */
function TapButton() {
  const { label, hot, tap } = useTapTempo((bpm) =>
    post("/api/click/bpm", { bpm }),
  );
  return (
    <button type="button" className={`tap-pill${hot ? " hot" : ""}`} onClick={tap}>
      {label}
    </button>
  );
}

function ClickVolume({ value }: { value: number }) {
  const ref = useRef<HTMLInputElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const v = Math.round((value ?? 0.8) * 100);
    el.value = String(v);
    el.style.setProperty("--pct", `${v}%`);
    if (numRef.current) numRef.current.textContent = String(v);
  }, [value]);

  return (
    <div className="vol">
      <VolumeIcon />
      <input
        ref={ref}
        type="range"
        min={0}
        max={100}
        defaultValue={80}
        aria-label="Click level"
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.setProperty("--pct", `${el.value}%`);
          if (numRef.current) numRef.current.textContent = el.value;
        }}
        onChange={(e) =>
          post("/api/click/volume", { volume: Number(e.currentTarget.value) / 100 })
        }
      />
      <span className="num" ref={numRef}>
        80
      </span>
    </div>
  );
}
