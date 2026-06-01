import { useEffect, useState } from "react";

/**
 * Estimates `serverNow - clientNow` in ms by sampling /api/time a few times
 * and keeping the sample with the smallest round-trip — that minimizes the
 * uncertainty in pinning the server timestamp to the client clock.
 *
 * Without this, click beat-dots on the phone drift by whatever skew exists
 * between the device and the host (often hundreds of ms on mobile).
 */
export function useServerClockOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const sample = async (): Promise<{ offset: number; rtt: number } | null> => {
      const t0 = Date.now();
      try {
        const r = await fetch("/api/time", { cache: "no-store" });
        const t1 = Date.now();
        const serverNow = Number(await r.json());
        if (!Number.isFinite(serverNow)) return null;
        const rtt = t1 - t0;
        // Assume the response was stamped roughly at the midpoint of the RTT.
        return { offset: serverNow - (t0 + rtt / 2), rtt };
      } catch {
        return null;
      }
    };

    const run = async () => {
      let best: { offset: number; rtt: number } | null = null;
      for (let i = 0; i < 5; i++) {
        const s = await sample();
        if (cancelled) return;
        if (s && (!best || s.rtt < best.rtt)) best = s;
      }
      if (!cancelled && best) setOffset(best.offset);
    };

    run();
    // Resample on tab focus — phones routinely adjust their clocks and we
    // don't want the dots to silently drift after a long suspend.
    const onFocus = () => {
      run();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return offset;
}
