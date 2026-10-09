/**
 * 재생 링크(SPEC F5-4 · 계약 v5 §G51): `/replay?at=<UTC ISO …Z>&bbox=w,s,e,n&hex=<6자리>` 를 만들고 읽는다. React 없음.
 * 읽을 때 값마다 검증한다 — 틀린 값은 버리고(기본값을 쓴다) 까닭을 안내 글로 돌려준다(조용히 다른 시각 · 영역을 보이지 않게).
 * - at: UTC ISO(…Z — 저장 · 전송 형식, 화면은 KST) · 재생할 수 있는 구간(최근 30일 ~ 1분 전 — lib/replay replayRange) 안.
 * - bbox: 위경도 범위 · w < e · s < n · 넓이 ≤ 재생 조회 상한(REPLAY_MAX_AREA_SQDEG).
 * - hex: 소문자 16진 6자리(대문자는 소문자로).
 */
import { REPLAY_MAX_AREA_SQDEG, replayRange } from "./replay";
import type { Bounds } from "./replay-link";

export { boundsAround, replayLink, type Bounds } from "./replay-link";
export interface ReplayUrl { at: number | null; bbox: Bounds | null; hex: string | null; notes: string[] }

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/;
const HEX = /^[0-9a-f]{6}$/;

export function parseReplayUrl(q: { get(k: string): string | null }, nowMs: number): ReplayUrl {
  const out: ReplayUrl = { at: null, bbox: null, hex: null, notes: [] };
  const at = q.get("at");
  if (at != null) {
    const t = ISO_Z.test(at) ? Date.parse(at) : NaN;
    const r = replayRange(nowMs);
    if (Number.isNaN(t)) out.notes.push("링크의 시각(at)을 읽을 수 없음 — …Z 로 끝나는 ISO 형식이 아님, 기본 시각(10분 전)으로 엽니다");
    else if (t < r.min || t > r.max) out.notes.push("링크의 시각이 재생할 수 있는 구간(최근 30일 ~ 1분 전) 밖 — 기본 시각(10분 전)으로 엽니다");
    else out.at = t;
  }
  const bb = q.get("bbox");
  if (bb != null) {
    const v = bb.split(",").map((x) => (x.trim() === "" ? NaN : Number(x)));
    const ok = v.length === 4 && v.every(Number.isFinite) && v[0] >= -180 && v[2] <= 180 && v[1] >= -90 && v[3] <= 90 && v[0] < v[2] && v[1] < v[3];
    if (!ok) out.notes.push("링크의 영역(bbox)을 읽을 수 없음 — 기본 영역으로 엽니다");
    else if ((v[2] - v[0]) * (v[3] - v[1]) > REPLAY_MAX_AREA_SQDEG) out.notes.push(`링크의 영역이 재생 조회 상한(${REPLAY_MAX_AREA_SQDEG.toLocaleString()} sq°)보다 넓음 — 기본 영역으로 엽니다`);
    else out.bbox = v as Bounds;
  }
  const hex = q.get("hex");
  if (hex != null) {
    const h = hex.trim().toLowerCase();
    if (HEX.test(h)) out.hex = h;
    else out.notes.push("링크의 항공기(hex)가 6자리 16진수가 아님 — 고르지 않고 엽니다");
  }
  return out;
}
