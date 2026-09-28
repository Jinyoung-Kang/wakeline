/**
 * WS 클라이언트 시험 도구(계약 v5 §E2 시험들이 같이 쓴다): 가짜 소켓 · 가짜 워커(보낸 메시지 기록, 실패 주입) · 오류 보고 기록.
 */
import { WakelineWsClient, type SocketLike } from "@/lib/ws";

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; this.onclose?.({ code: code ?? 1005 }); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  types() { return this.sent.map((m) => m.type); }
}

export interface WorkerMsg { type: string; aircraft?: { hex: string }[]; upsert?: { hex: string }[]; remove?: string[] }
export function setup() {
  const sockets: FakeSocket[] = [];
  const worker = { msgs: [] as WorkerMsg[], fail: null as null | ((m: WorkerMsg) => boolean), postMessage(m: unknown) {
    if (this.fail?.(m as WorkerMsg)) throw new Error("worker postMessage failed");
    this.msgs.push(m as WorkerMsg);
  } };
  const reports: { message: string; stack?: string | null; component?: string | null }[] = [];
  const client = new WakelineWsClient(worker, {
    url: "ws://test/ws/v1", isHidden: () => false,
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    report: (r) => { reports.push(r); },
  });
  return { client, worker, reports, sockets, ws: () => sockets[sockets.length - 1] };
}
export const TS = "2026-09-29T03:00:00Z";
export const BBOX: [number, number, number, number] = [124, 33, 132, 39];
export const ac = (hex: string, lat = 36, lon = 127) => ({ hex, lat, lon, seen_at: TS, provider: "adsb_fi", on_ground: false, quality: 0 });
export const snap = (aircraft: unknown[]) => ({ type: "snapshot", seq: 1, v: 1, ts: TS, sources: { region: { provider: "adsb_fi", fetched_at: TS, lag_s: 1, stale: false }, global: null }, sigmets_version: 1, aircraft });
export const diff = (seq: number, upsert: unknown[], remove: unknown[] = []) => ({ type: "diff", seq, v: seq, ts: TS, upsert, remove });
export const resyncs = (t: ReturnType<typeof setup>) => t.ws().types().filter((x) => x === "resync").length;

export function welcomed(t: ReturnType<typeof setup>, ships = false) {
  t.client.subscribe(BBOX, 7);
  if (ships) t.client.setLayers(true, true);
  t.client.connect();
  t.ws().open();
  t.ws().recv({ type: "welcome", session_id: "s", server_time: TS, snapshot_version: 1, limits: {} });
}

