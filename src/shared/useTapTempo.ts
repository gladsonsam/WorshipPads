// Tap-tempo: tap a button in time and read a BPM from the gaps between taps.
// Shared by the desktop click page (src/components/ui.tsx) and the phone
// remote (src/remote/components/ClickTab.tsx) so the tempo math — and the
// little "tap N of 4…" prompt — stay identical on both surfaces.
//
// Keeps a rolling window of recent tap timestamps and reports a fresh BPM from
// the 2nd tap onward, using the *median* inter-tap gap so one stray tap can't
// throw the estimate. A pause longer than RESET_GAP starts a new attempt (the
// window clears); after IDLE_RESET of no taps the window clears too so a stale
// half-finished count doesn't linger on the button.

import { useEffect, useRef, useState } from "react";

const MAX_TAPS = 5; // rolling window size
const RESET_GAP = 2000; // ms; a longer pause begins a fresh attempt
const IDLE_RESET = 2200; // ms; clear the on-screen prompt after this much idle
const MIN_BPM = 30;
const MAX_BPM = 300;

export interface TapTempo {
  /** Prompt for the button: "TAP", "tap again…", or "tap 3 of 4…". */
  label: string;
  /** True while a tap attempt is in progress (for an active/highlight style). */
  hot: boolean;
  /** Call on each tap (button click). */
  tap: () => void;
}

/**
 * @param onBpm called with the latest median-derived BPM (rounded to 0.1),
 *              from the 2nd tap onward. The caller commits it upstream.
 */
export function useTapTempo(onBpm: (bpm: number) => void): TapTempo {
  const tapsRef = useRef<number[]>([]);
  const idleTimer = useRef<number | null>(null);
  // Mirror the latest callback so the idle timer closure stays current.
  const onBpmRef = useRef(onBpm);
  onBpmRef.current = onBpm;

  const [label, setLabel] = useState("TAP");
  const [hot, setHot] = useState(false);

  useEffect(
    () => () => {
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    },
    [],
  );

  const tap = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    const last = taps[taps.length - 1];
    if (last != null && now - last > RESET_GAP) taps.length = 0;
    taps.push(now);
    if (taps.length > MAX_TAPS) taps.shift();

    if (taps.length >= 2) {
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, 60_000 / median));
      onBpmRef.current(Math.round(bpm * 10) / 10);
    }

    const n = taps.length;
    setLabel(n === 1 ? "tap again…" : n < 4 ? `tap ${n} of 4…` : "TAP");
    setHot(n > 0);

    if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      tapsRef.current.length = 0;
      setLabel("TAP");
      setHot(false);
    }, IDLE_RESET);
  };

  return { label, hot, tap };
}
