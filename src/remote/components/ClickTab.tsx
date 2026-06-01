import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../shared/types";
import { useHoldRepeat } from "../../shared/useHoldRepeat";
import { post } from "../api";
import { MinusIcon, PlusIcon, VolumeIcon } from "./icons";

const clampBpm = (v: number) => Math.max(30, Math.min(300, Math.round(v)));

interface Props {
  now: NowPlaying;
}

export function ClickTab({ now }: Props) {
  const bpm = Math.round(now.click?.bpm ?? 90);
  const beats = now.click?.beats_per_bar ?? 4;
  const enabled = !!now.click?.enabled;

  return (
    <section className="tab-body" role="tabpanel" aria-label="Click">
      <BpmBlock bpm={bpm} />

      <BeatDots
        beats={beats}
        bpm={now.click?.bpm ?? 90}
        startedAt={now.click?.started_at_ms ?? null}
        enabled={enabled}
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

      <TapButton currentBpm={now.click?.bpm ?? 90} />

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
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const startRef = useRef(0);
  const sendBpm = (v: number) => post("/api/click/bpm", { bpm: clampBpm(v) });

  const minusProps = useHoldRepeat((n) => {
    if (n === 1) startRef.current = bpmRef.current;
    sendBpm(startRef.current - n);
  });
  const plusProps = useHoldRepeat((n) => {
    if (n === 1) startRef.current = bpmRef.current;
    sendBpm(startRef.current + n);
  });

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
 */
function BeatDots({
  beats,
  bpm,
  startedAt,
  enabled,
}: {
  beats: number;
  bpm: number;
  startedAt: number | null;
  enabled: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const paint = () => {
      const el = containerRef.current;
      if (!el) return;
      const dots = el.children;
      if (!enabled || !startedAt || !bpm) {
        for (let i = 0; i < dots.length; i++) dots[i].classList.remove("on");
        return;
      }
      const idx =
        Math.floor(((Date.now() - startedAt) * bpm) / 60000) % Math.max(1, beats);
      for (let i = 0; i < dots.length; i++) {
        dots[i].classList.toggle("on", i === idx);
      }
    };
    paint();
    if (!enabled) return;
    const id = window.setInterval(paint, 50);
    return () => window.clearInterval(id);
  }, [enabled, startedAt, bpm, beats]);

  return (
    <div className="beat-dots" ref={containerRef}>
      {Array.from({ length: Math.max(1, beats) }).map((_, i) => (
        <span key={i} className={`dot${i === 0 ? " one" : ""}`} />
      ))}
    </div>
  );
}

/** Rolling 5-tap window, median delta → BPM. Resets after 2.2s of idle. */
function TapButton({ currentBpm: _currentBpm }: { currentBpm: number }) {
  const tapsRef = useRef<number[]>([]);
  const resetRef = useRef<number | null>(null);
  const [label, setLabel] = useState("TAP");
  const [hot, setHot] = useState(false);

  const onTap = () => {
    const t = performance.now();
    const last = tapsRef.current[tapsRef.current.length - 1];
    if (last != null && t - last > 2000) tapsRef.current = [];
    tapsRef.current.push(t);
    if (tapsRef.current.length > 5) tapsRef.current.shift();

    if (tapsRef.current.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < tapsRef.current.length; i++) {
        deltas.push(tapsRef.current[i] - tapsRef.current[i - 1]);
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const bpm = Math.max(30, Math.min(300, 60000 / median));
      post("/api/click/bpm", { bpm: Math.round(bpm * 10) / 10 });
    }

    const n = tapsRef.current.length;
    if (n === 1) setLabel("tap again…");
    else if (n < 4) setLabel(`tap ${n} of 4…`);
    else setLabel("TAP");
    setHot(n > 0);

    if (resetRef.current != null) window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => {
      tapsRef.current = [];
      setLabel("TAP");
      setHot(false);
    }, 2200);
  };

  useEffect(
    () => () => {
      if (resetRef.current != null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  return (
    <button type="button" className={`tap-pill${hot ? " hot" : ""}`} onClick={onTap}>
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
