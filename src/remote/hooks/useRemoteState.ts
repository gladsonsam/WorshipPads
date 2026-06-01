import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../shared/types";
import { fetchInfo, type Info } from "../api";

const DEFAULT_NOW: NowPlaying = {
  key: null,
  preset: null,
  volume: 0.8,
  playing: false,
  click: {
    enabled: false,
    bpm: 90,
    beats_per_bar: 4,
    volume: 0.8,
    accent: true,
    started_at_ms: null,
  },
};

export type ConnState = "connected" | "reconnecting";

interface RemoteState {
  info: Info | null;
  now: NowPlaying;
  conn: ConnState;
}

/**
 * One-stop subscription: fires /api/info once, then keeps a WebSocket open and
 * mirrors NowPlaying broadcasts into React state. Auto-reconnects on close.
 */
export function useRemoteState(): RemoteState {
  const [info, setInfo] = useState<Info | null>(null);
  const [now, setNow] = useState<NowPlaying>(DEFAULT_NOW);
  const [conn, setConn] = useState<ConnState>("reconnecting");
  const closedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchInfo()
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setNow(normalize(i.now));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConn("connected");
      ws.onclose = () => {
        setConn("reconnecting");
        if (closedRef.current) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
      ws.onmessage = (e) => {
        try {
          setNow(normalize(JSON.parse(e.data) as NowPlaying));
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { info, now, conn };
}

/** Defensively backfill click in case an older backend omits it. */
function normalize(n: NowPlaying): NowPlaying {
  if (!n.click) {
    return { ...n, click: DEFAULT_NOW.click };
  }
  return n;
}
