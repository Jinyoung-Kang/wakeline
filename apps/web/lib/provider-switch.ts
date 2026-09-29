/**
 * 공급자 스위치(R-94, 계약 v5 §D1 · ADR-019). 원본은 DB provider_switch 이고, 수집기는 호출마다 Redis wakeline:provider:{name}.disabled(미러)를 읽어 따른다
 * ("1" 이면 꺼짐, 그 밖·없음은 켜짐 — Redis 를 읽지 못하면 마지막으로 읽은 값). api 는 토글 커밋 뒤 미러하고, 60 s 마다(StartupMirror) 다시 미러한다.
 * 운영 화면은 원본과 미러를 나란히 보이고, 토글이 미러되지 않았으면(mirrored=false) 수집기가 아직 이전 값을 따른다고 경고한다.
 * 서버는 null 필드를 응답에서 뺀다 — 없음 = 모름(추정해 채우지 않는다). 시각은 KST(lib/time — 문장 속이라 "… KST").
 */
import { fmtKst } from "./time";

/** GET /api/v1/ops/providers 의 provider_switch 원소 */
export interface SwitchState {
  provider: string;
  /** 원본(DB). 없으면 행이 없다(이관 전) */
  disabled?: boolean | null;
  version?: number | null;
  updated_at?: string | null;
  /** 바꾼 운영자. 행이 있는데 없으면 시스템(Redis 값 이관) */
  updated_by?: string | null;
  /** Redis 미러 원문(필드 없음 = 없음) */
  redis_disabled?: string | null;
  redis_error?: string | null;
  /** 수집기가 따르는 값이 원본과 다른가. 없으면 모름(행 없음·Redis 를 읽지 못함) */
  mirror_differs?: boolean | null;
}

/** POST /api/v1/ops/providers/{name}/{enable|disable} 응답 */
export interface ToggleResult { provider: string; disabled: boolean; version: number; updated_at: string; mirrored: boolean }

/** api 의 주기 미러(StartupMirror fixedDelay) — 초 */
export const MIRROR_PERIOD_S = 60;

const onOff = (disabled: boolean) => (disabled ? "꺼짐" : "켜짐");

/** 토글 결과 문구. ok=false(미러 실패)는 경고(role=alert)로 보인다. provider · version 은 {@link liveNote} 가 지금 상태와 맞춰 보는 데 쓴다. */
export interface SwitchNote { ok: boolean; text: string; provider: string; version: number }

export function toggleNote(r: ToggleResult): SwitchNote {
  const head = `${r.provider} ${r.disabled ? "끔" : "켬"} — DB 원본 반영(v${r.version} · ${fmtKst(r.updated_at)})`;
  if (r.mirrored) return { ok: true, text: `${head} · Redis 미러 반영 — 수집기는 다음 호출부터 따른다`, provider: r.provider, version: r.version };
  return {
    ok: false,
    text: `${head} · Redis 미러 실패 — 수집기는 아직 이전 값을 따른다. Redis 가 돌아오면 api 가 ${MIRROR_PERIOD_S} s 주기로 다시 미러한다`,
    provider: r.provider, version: r.version,
  };
}

/**
 * 미러 실패 경고는 '지금' 사실일 때만 경고로 둔다: 새로고침한 provider_switch 에서 그 공급자가 같은(또는 더 새) 버전으로 미러와 같아졌으면
 * (주기 미러가 맞췄다) 상태 줄로 바꾼다. 모르면(Redis 를 읽지 못함 · 다름) 경고 그대로.
 */
export function liveNote(note: SwitchNote | null, list: SwitchState[] | undefined): SwitchNote | null {
  if (!note || note.ok) return note;
  const s = list?.find((x) => x.provider === note.provider);
  if (!s || s.disabled == null || s.mirror_differs !== false || (s.version ?? 0) < note.version) return note;
  return { ...note, ok: true, text: `${s.provider} v${s.version} — 이제 Redis 미러 반영(api 주기 미러) · 수집기가 원본(${onOff(s.disabled)})을 따른다` };
}

/** 표 칸: 원본 값(on/off vN)과 미러 상태 배지 + 설명(title) */
export function switchCell(s: SwitchState | undefined): { source: string; mirror: string; tone: "ok" | "warn" | "muted"; title: string } {
  if (!s || s.disabled == null) {
    return { source: "—", mirror: "미러 —", tone: "muted", title: "원본(DB provider_switch) 행 없음 — 이관 전. 수집기는 Redis 값을 따른다" };
  }
  const by = s.updated_by ?? "시스템(이관)";
  const src = `원본 DB provider_switch: ${onOff(s.disabled)} · v${s.version ?? "—"} · ${fmtKst(s.updated_at)} · ${by}`;
  const redis = `Redis disabled=${s.redis_disabled ?? "(없음)"}`;
  if (s.redis_error || s.mirror_differs == null) {
    return { source: `${s.disabled ? "off" : "on"} v${s.version ?? "—"}`, mirror: "미러 ?", tone: "warn", title: `${src}\nRedis 를 읽지 못함 — 수집기가 따르는 값을 모른다` };
  }
  if (s.mirror_differs) {
    return {
      source: `${s.disabled ? "off" : "on"} v${s.version ?? "—"}`, mirror: "미러 다름", tone: "warn",
      title: `${src}\n${redis} — 수집기는 이 값(${onOff(s.redis_disabled === "1")})을 따른다. api 가 ${MIRROR_PERIOD_S} s 주기로 원본을 다시 미러한다`,
    };
  }
  return { source: `${s.disabled ? "off" : "on"} v${s.version ?? "—"}`, mirror: "미러 같음", tone: "ok", title: `${src}\n${redis} — 수집기가 원본과 같은 값을 따른다` };
}

/** 미러가 원본과 다른 공급자 — "adsbdb(원본 꺼짐 · 수집기 켜짐)". 모름(null)은 넣지 않는다. */
export function mirrorDiffers(list: SwitchState[] | undefined): string[] {
  return (list ?? []).filter((s) => s.mirror_differs === true && s.disabled != null)
    .map((s) => `${s.provider}(원본 ${onOff(s.disabled!)} · 수집기 ${onOff(s.redis_disabled === "1")})`);
}
