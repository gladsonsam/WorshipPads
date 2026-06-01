// Press-and-hold stepper with auto-repeat + acceleration.
//
// One handler bundle per +/− button. Spread the result onto the button.
// On tap (or keyboard Space/Enter), `apply(value + step)` fires once. On
// press-and-hold, the same target accumulates and auto-repeats, speeding up
// over time.
//
// The hook owns the start-anchor snapshot so the consumer doesn't have to
// maintain a `valueRef` mirror per button — the previous shape pushed that
// responsibility onto callers and led to (a) a single `startRef` shared
// across +/− that multi-touch could corrupt, and (b) rapid taps within a
// network RTT all snapshotting the same stale value (so the target never
// accumulated). Both are gone now: every `useHoldRepeat` instance has its
// own start ref, and consecutive taps within `coalesceWindow` reuse the
// last-sent target as the anchor so multi-tap accumulation works even
// before the upstream value catches up.

import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useEffect, useRef } from "react";

interface HoldRepeatCfg {
  initialDelay?: number;
  startInterval?: number;
  minInterval?: number;
  speedupAfter?: number;
  speedupFactor?: number;
  /**
   * If a new tap arrives within this many ms of the last applied step, it
   * accumulates on top of the last-applied target rather than re-anchoring
   * to `value`. Lets three rapid taps actually move BPM by 3, even when the
   * upstream WebSocket hasn't echoed back the first one yet.
   */
  coalesceWindow?: number;
}

interface HoldRepeatProps {
  /** Spread onto the button. */
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  /** Keyboard activation (Space/Enter on focused <button>) → single step. */
  onClick: (e: MouseEvent<HTMLElement>) => void;
  /** Optional: lets parent extend the keyboard story (e.g. arrow keys). */
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * @param value the current authoritative value (e.g. the BPM prop from props)
 * @param step  signed increment per tick — pass +1 for the "plus" button, -1 for "minus"
 * @param apply called with the next target value (already advanced by `step` * n)
 */
export function useHoldRepeat(
  value: number,
  step: number,
  apply: (target: number) => void,
  cfg: HoldRepeatCfg = {},
): HoldRepeatProps {
  const {
    initialDelay = 350,
    startInterval = 110,
    minInterval = 22,
    speedupAfter = 700,
    speedupFactor = 0.7,
    coalesceWindow = 1500,
  } = cfg;

  // Mirror the latest prop so the timer callback (which closes over its
  // first-render snapshot) can read the current value at tick time.
  const valueRef = useRef(value);
  valueRef.current = value;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const timerRef = useRef<number | null>(null);
  // Last target we asked the consumer to apply; used as the anchor when a
  // follow-up tap arrives before `value` has caught up.
  const lastTargetRef = useRef<number | null>(null);
  const lastTargetAtRef = useRef(0);

  const stop = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => stop(), []);

  const nowMs = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  // Pick the anchor for a new session: either the last target (if a recent
  // tap is still pending) or the current authoritative value.
  const anchor = (): number => {
    const t = lastTargetRef.current;
    if (t != null && nowMs() - lastTargetAtRef.current < coalesceWindow) {
      return t;
    }
    return valueRef.current;
  };

  const fire = (target: number) => {
    lastTargetRef.current = target;
    lastTargetAtRef.current = nowMs();
    applyRef.current(target);
  };

  const oneStep = () => {
    fire(anchor() + step);
  };

  const start = () => {
    stop();
    const base = anchor();
    let n = 1;
    fire(base + step * n);
    let interval = startInterval;
    let elapsed = 0;
    const tick = () => {
      n += 1;
      fire(base + step * n);
      elapsed += interval;
      if (elapsed >= speedupAfter && interval > minInterval) {
        interval = Math.max(minInterval, Math.round(interval * speedupFactor));
        elapsed = 0;
      }
      timerRef.current = window.setTimeout(tick, interval);
    };
    timerRef.current = window.setTimeout(tick, initialDelay);
  };

  return {
    onPointerDown: (e) => {
      // Reject non-primary mouse buttons; let touch/pen through (their
      // synthesized button is also 0).
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Keyboard-synthesized click on a <button>: detail === 0. Real pointer
    // clicks have detail >= 1 and have already been handled by pointerdown,
    // so this branch only fires for Space/Enter activation.
    onClick: (e) => {
      if (e.detail === 0) oneStep();
    },
  };
}
