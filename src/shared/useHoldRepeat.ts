// Press-and-hold auto-repeat with acceleration.
// Tap → onStep(1) once. Hold past `initialDelay` → onStep keeps firing on a
// timer that speeds up over time. n is the cumulative tick count (1, 2, 3…),
// so consumers can snapshot a start value on n===1 and target start + n.

import type { PointerEvent } from "react";
import { useEffect, useRef } from "react";

interface HoldRepeatCfg {
  initialDelay?: number;
  startInterval?: number;
  minInterval?: number;
  speedupAfter?: number;
  speedupFactor?: number;
}

export function useHoldRepeat(onStep: (n: number) => void, cfg: HoldRepeatCfg = {}) {
  const {
    initialDelay = 350,
    startInterval = 110,
    minInterval = 22,
    speedupAfter = 700,
    speedupFactor = 0.7,
  } = cfg;

  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const timerRef = useRef<number | null>(null);

  const stop = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => stop, []);

  const start = () => {
    stop();
    let n = 1;
    onStepRef.current(n);
    let interval = startInterval;
    let elapsed = 0;
    const tick = () => {
      n += 1;
      onStepRef.current(n);
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
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  };
}
