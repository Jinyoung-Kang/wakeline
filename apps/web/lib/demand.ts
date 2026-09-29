/**
 * 수요 기반 정밀 추적 표시(ADR-013 · 계약 v2 §A3/§B4) — 순수 함수.
 * 서버 → {type:"demand", hot:{cell, radius_nm, state, interval_s}|null, focus:{hex, state, interval_s, since}|null} (변할 때와 30 s 마다).
 * 화면은 서버가 보고한 상태·주기만 말한다: interval_s 가 없으면 주기를 쓰지 않는다(“5초”를 지어내지 않는다).
 * 경과(N분째)는 서버가 준 since 와 서버 기준 현재 시각의 차이 — 결정적 계산이다.
 */
import { fmtKstTitle } from "./format";
import type { Tone } from "./tooltip";

export const HOT_STATES = ["active", "pending", "throttled", "covered_by_region", "error", "disabled", "limited"] as const;
export const FOCUS_STATES = ["active", "pending", "throttled", "not_found", "error", "disabled", "expired_session_cap", "limited"] as const;
export type HotState = (typeof HOT_STATES)[number];
export type FocusState = (typeof FOCUS_STATES)[number];

export interface HotDemand { cell: string | null; radius_nm: number | null; state: HotState; interval_s: number | null }
export interface FocusDemand { hex: string; state: FocusState; interval_s: number | null; since: string | null }
export interface DemandInfo { hot: HotDemand | null; focus: FocusDemand | null; received_at: number }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX_RE = /^[0-9a-f]{6}$/;
const CELL_RE = /^-?\d{1,2}\.[05]:-?\d{1,3}\.[05]:\d{2,3}$/;
const posNum = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : null);

function parseHot(v: unknown): HotDemand | null {
  if (!isObj(v) || typeof v.state !== "string" || !(HOT_STATES as readonly string[]).includes(v.state)) return null;
  return {
    cell: typeof v.cell === "string" && CELL_RE.test(v.cell) ? v.cell : null,
    radius_nm: posNum(v.radius_nm, 500),
    state: v.state as HotState,
    interval_s: posNum(v.interval_s, 3600),
  };
}

function parseFocus(v: unknown): FocusDemand | null {
  if (!isObj(v) || typeof v.hex !== "string" || !HEX_RE.test(v.hex)) return null;
  if (typeof v.state !== "string" || !(FOCUS_STATES as readonly string[]).includes(v.state)) return null;
  const since = typeof v.since === "string" && v.since.length <= 40 && !Number.isNaN(Date.parse(v.since)) ? v.since : null;
  return { hex: v.hex, state: v.state as FocusState, interval_s: posNum(v.interval_s, 3600), since };
}

/** 모르는 상태 문자열·형식이 틀린 항목은 null(표시하지 않음) — 상태를 추측하지 않는다. */
export function parseDemand(m: Obj, receivedAt: number): DemandInfo {
  return { hot: parseHot(m.hot), focus: parseFocus(m.focus), received_at: receivedAt };
}

export interface Chip { text: string; tone: Tone; title: string; kind: "focus" | "hot" }

/** 경과 분: 1분 미만은 "1분 미만", 그 뒤로는 "N분째"(since → 서버 기준 지금). since 를 모르면 null. */
export function elapsedLabel(since: string | null, nowMs: number): string | null {
  if (!since || !nowMs) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  const min = Math.floor(Math.max(0, nowMs - t) / 60_000);
  return min < 1 ? "1분 미만" : `${min}분째`;
}

const every = (s: number | null) => (s == null ? "" : ` ${fmtInterval(s)}`);
function fmtInterval(s: number) { return Number.isInteger(s) ? `${s}초` : `${s.toFixed(1)}초`; }

/**
 * 선택 항공기의 집중 추적 칩(카드·지도). 서버가 이 hex 에 대해 보고한 상태가 없으면 null.
 * active "집중 추적 5초 · 3분째" · pending "집중 추적 대기" · throttled "호출 상한으로 지연" · not_found "공급자에서 찾지 못함" ·
 * error "집중 추적 오류" · disabled "공급자 꺼짐(운영자)" · expired_session_cap "집중 추적 30분 상한" · limited "추적 변경 제한".
 */
export function focusChip(d: DemandInfo | null, hex: string | null, nowMs: number): Chip | null {
  const f = d?.focus;
  if (!f || !hex || f.hex !== hex) return null;
  const el = elapsedLabel(f.since, nowMs);
  const base = "서버 수집기가 이 항공기만 ICAO 24비트 hex 로 따로 조회합니다(브라우저는 공급자를 직접 부르지 않음). 선택을 해제하거나 창을 닫으면 최대 60초 안에 멈춥니다.";
  const cadence = f.interval_s != null ? `서버가 보고한 조회 주기 ${fmtInterval(f.interval_s)}.` : "서버가 조회 주기를 보고하지 않음.";
  switch (f.state) {
    case "active":
      return { kind: "focus", tone: "ok", text: `집중 추적${every(f.interval_s)}${el ? ` · ${el}` : ""}`, title: `${base} ${cadence}${f.since ? ` 시작 ${fmtKstTitle(f.since)}.` : ""}` };
    case "pending":
      return { kind: "focus", tone: "muted", text: "집중 추적 대기", title: `수집기가 아직 이 항공기를 조회하지 않았습니다. ${base}` };
    case "throttled":
      return { kind: "focus", tone: "warn", text: `호출 상한으로 지연${f.interval_s != null ? ` · ${fmtInterval(f.interval_s)} 간격` : ""}`, title: `공급자 호출 상한(수집기 전체) 때문에 목표 주기를 지키지 못하고 있습니다. ${cadence}` };
    case "not_found":
      return { kind: "focus", tone: "warn", text: "공급자에서 찾지 못함", title: "공급자가 이 hex 의 현재 위치를 돌려주지 않았습니다(수신 범위 밖·송신 중단 등). 마지막 관측만 남습니다." };
    case "error":
      return { kind: "focus", tone: "bad", text: "집중 추적 오류", title: "공급자 조회가 실패하고 있습니다. 지도는 일반 갱신 주기로만 움직입니다." };
    case "expired_session_cap":
      return { kind: "focus", tone: "warn", text: "집중 추적 30분 상한 — 다시 선택하면 이어짐", title: "한 세션의 연속 집중 추적은 30분까지입니다(호출 비용 상한, ADR-013). 항공기를 다시 선택하면 새로 시작합니다." };
    case "disabled":
      return { kind: "focus", tone: "muted", text: "집중 추적 중지 · 공급자 꺼짐(운영자)", title: "운영자가 이 공급자(adsb.fi)를 꺼서 수집기가 조회하지 않습니다. 지도는 일반 갱신 주기로만 움직입니다." };
    case "limited":
      return { kind: "focus", tone: "warn", text: "추적 변경 제한 — 잠시 뒤 반영", title: "한 창에서 1분에 새로 집중 추적을 시작할 수 있는 항공기는 6대까지입니다(호출 남용 방지). 1분 안에 반영되며, 그동안 이 항공기는 따로 조회하지 않습니다." };
  }
}

/** 핫 리전 칩(지도). 선택 항공기가 없고 줌 ≥ 7 일 때 서버가 보내는 hot. */
export function hotChip(d: DemandInfo | null): Chip | null {
  const h = d?.hot;
  if (!h) return null;
  const r = h.radius_nm != null ? `반경 ${Math.round(h.radius_nm)} NM` : null;
  const title = "화면 중심 주변을 서버 수집기가 따로 조회합니다(여러 사용자가 같은 칸을 보면 한 번만). 축소·이동하거나 아무도 보지 않으면 60초 안에 멈춥니다.";
  switch (h.state) {
    case "active":
      return { kind: "hot", tone: "ok", text: `핫 리전${every(h.interval_s)} 갱신${r ? `(${r})` : ""}`, title: `${title}${h.interval_s != null ? ` 서버가 보고한 주기 ${fmtInterval(h.interval_s)}.` : " 서버가 주기를 보고하지 않음."}` };
    case "pending":
      return { kind: "hot", tone: "muted", text: `핫 리전 대기${r ? `(${r})` : ""}`, title: `수집기가 아직 이 지역을 조회하지 않았습니다. ${title}` };
    case "throttled":
      return { kind: "hot", tone: "warn", text: `핫 리전 호출 상한으로 지연${h.interval_s != null ? ` · ${fmtInterval(h.interval_s)} 간격` : ""}${r ? `(${r})` : ""}`, title: `공급자 호출 상한 때문에 주기를 늘렸거나 이 칸을 건너뛰고 있습니다. ${title}` };
    case "covered_by_region":
      return { kind: "hot", tone: "muted", text: `관심 지역 수집 범위 안${h.interval_s != null ? ` · ${fmtInterval(h.interval_s)} 갱신` : ""}`, title: "화면 중심이 고정 관심 지역 안이라 따로 조회하지 않습니다 — 관심 지역 수집이 이미 이곳을 다룹니다." };
    case "error":
      return { kind: "hot", tone: "bad", text: `핫 리전 조회 오류${r ? `(${r})` : ""}`, title: `공급자 조회가 실패하고 있습니다. 지도는 일반 갱신 주기로만 움직입니다. ${title}` };
    case "disabled":
      return { kind: "hot", tone: "muted", text: "핫 리전 중지 · 공급자 꺼짐(운영자)", title: "운영자가 이 공급자(adsb.fi)를 꺼서 수집기가 이 지역을 따로 조회하지 않습니다." };
    case "limited":
      return { kind: "hot", tone: "warn", text: "핫 리전 변경 제한 — 잠시 뒤 반영", title: "한 창에서 1분에 새로 조회를 시작할 수 있는 지역은 6칸까지입니다(호출 남용 방지). 1분 안에 반영되며, 그동안 이 칸은 따로 조회하지 않습니다." };
  }
}

/** 지도 칩: 선택 항공기가 있으면 집중 추적, 없으면 핫 리전. */
export function mapDemandChip(d: DemandInfo | null, selectedHex: string | null, nowMs: number): Chip | null {
  if (selectedHex) return focusChip(d, selectedHex, nowMs);
  return hotChip(d);
}
