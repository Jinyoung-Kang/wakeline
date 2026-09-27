/**
 * WS 클라이언트(9.5절 · 11.4절): hello → subscribe(bbox) → snapshot/diff. 지수 백오프 재접속(1→30 s),
 * 재접속 후 subscribe·select 재전송, v 불연속 시 resync, 탭 숨김 시 pause/resume, ping/pong.
 */
import { nextBackoffMs, needsResync } from "./ws-protocol";
import { aircraftStates, getData, setData } from "./store";
import type { AircraftState, Alert, RadarFrames, SigmetCollection } from "./types";

export type WorkerLike = { postMessage: (m: unknown) => void };

export class SkyWsClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastV = 0;
  private bbox: [number, number, number, number] | null = null;
  private zoom = 7;
  private selected: string | null = null;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private worker: WorkerLike, private url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1`) {}

  connect() {
    this.closedByUser = false;
    setData({ conn: "connecting", reconnectAttempt: this.attempt });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastV = 0;
      this.send({ type: "hello", proto: 1, client: "web/0.2" });
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      setData({ conn: "closed" });
      if (this.closedByUser) return;
      const delay = nextBackoffMs(this.attempt++);
      this.timer = setTimeout(() => this.connect(), delay);
      setData({ reconnectAttempt: this.attempt });
    };
    ws.onerror = () => { /* onclose 가 이어서 처리 */ };
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
  }

  subscribe(bbox: [number, number, number, number], zoom: number) {
    this.bbox = bbox;
    this.zoom = zoom;
    this.send({ type: "subscribe", bbox, zoom, detail: "lite" });
  }

  select(hex: string | null) {
    this.selected = hex;
    this.send({ type: "select", hex });
  }

  pause() { this.send({ type: "pause" }); setData({ conn: "paused" }); }
  resume() { this.send({ type: "resume" }); setData({ conn: "open" }); }
  resync() { this.send({ type: "resync" }); }

  private send(o: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private onMessage(raw: string) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "welcome":
        setData({ conn: "open" });
        if (this.bbox) this.subscribe(this.bbox, this.zoom);
        if (this.selected) this.select(this.selected);
        break;
      case "snapshot": {
        const aircraft = m.aircraft as AircraftState[];
        aircraftStates.clear();
        for (const a of aircraft) aircraftStates.set(a.hex, a);
        this.worker.postMessage({ type: "snapshot", aircraft });
        this.lastV = m.v as number;
        setData({
          snapshotVersion: m.v as number, snapshotAt: m.ts as string, provider: m.provider as string,
          lagS: m.lag_s as number, stale: m.stale as boolean, scope: (m.scope as "region" | "world") ?? "region", aircraftCount: aircraft.length,
        });
        break;
      }
      case "diff": {
        const v = m.v as number;
        if (needsResync(this.lastV, v)) { this.resync(); return; }
        this.lastV = v;
        const upsert = m.upsert as AircraftState[];
        const remove = m.remove as string[];
        for (const a of upsert) aircraftStates.set(a.hex, a);
        for (const h of remove) aircraftStates.delete(h);
        this.worker.postMessage({ type: "diff", upsert, remove });
        setData({ snapshotVersion: v, snapshotAt: m.ts as string, aircraftCount: aircraftStates.size, stale: false });
        break;
      }
      case "sigmets":
        setData({ sigmets: m.collection as SigmetCollection, sigmetsVersion: m.v as number, sigmetsFetchedAt: m.fetched_at as string, sigmetsProvider: m.provider as string });
        break;
      case "radar":
        setData({ radar: { host: m.host as string, generated: m.generated as number, past: m.past as RadarFrames["past"], fetched_at: m.fetched_at as string, provider: m.provider as string } });
        break;
      case "alerts": {
        const map = new Map<number, Alert>();
        for (const a of m.alerts as Alert[]) map.set(a.id, a);
        setData({ alerts: map });
        break;
      }
      case "alerts_batch": {
        const map = new Map(getData().alerts);
        let last = getData().lastEvent;
        for (const it of m.items as { event: string; alert: Alert }[]) {
          if (it.event === "ENTERED" || it.event === "PREDICTED" || it.event === "PREDICTION_UPDATED") map.set(it.alert.id, it.alert);
          else map.delete(it.alert.id);
          last = { type: it.event, alert: it.alert, at: Date.now() };
        }
        setData({ alerts: map, lastEvent: last });
        break;
      }
      case "status":
        setData({ status: m.status as never });
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "error":
        console.warn("ws error", m.code, m.detail);
        break;
    }
  }
}
