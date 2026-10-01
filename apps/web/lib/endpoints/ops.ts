/**
 * 운영 REST(web-review §3.1) — 운영 화면(/ops) · 시스템 로그 화면(/logs)의 세션 · 탭 조회 · 쓰기 · 해결 처리. 둘 다 첫 화면 밖이다.
 * 쓰기는 lib/api apiSend(CSRF 머리 — 이중 제출), 읽기는 apiGet. 경로 조각(공급자 이름 · 설정 키)은 lib/ops 의 경로 함수가 인코딩한다(web-review B11).
 * 읽기는 { signal } 을 받아 그대로 넘긴다. 본문은 화면이 읽는다(해결 201 만 lib/resolutions parseResolution 으로 — 형식이 틀리면 null).
 */
import { apiGet, apiSend } from "@/lib/api";
import { OPS_SESSION_PATH, providerSwitchPath, settingPath } from "@/lib/ops";
import { runsDrillPath, type RunKey } from "@/lib/ops-runs";
import type { ToggleResult } from "@/lib/provider-switch";
import { parseResolution, RESOLUTIONS_PATH, resolutionBody, resolutionPath, type Resolution, type ResolutionDraft, type ResolvedMode } from "@/lib/resolutions";

type Opts = { signal?: AbortSignal };

export interface OpsUser { username: string }

// ---- 세션(R-12) ----

/** 지금 세션의 운영자 — 401/404 면 로그인 안 됨(lib/ops isAuthMiss) */
export function opsSession(o?: Opts): Promise<OpsUser> {
  return apiGet<OpsUser>(OPS_SESSION_PATH, o);
}
/** 로그인(R-56) */
export function signIn(username: string, password: string): Promise<OpsUser> {
  return apiSend<OpsUser>("POST", OPS_SESSION_PATH, { username, password });
}
/** 로그아웃 요청(실패해도 화면은 로그인으로 — lib/ops signOut) */
export function signOutRequest(): Promise<unknown> {
  return apiSend("DELETE", OPS_SESSION_PATH);
}

// ---- 운영 화면의 탭(엔드포인트)마다 조회 ----

export type OpsTab = "providers" | "runs" | "quality" | "settings" | "audit" | "dlq" | "pipeline";
/** 탭마다 불러오는 엔드포인트 — 마지막 성공 시각·실패를 탭마다 따로 둔다(R-12) */
const TAB_PATH: Record<OpsTab, string> = {
  providers: "/api/v1/ops/providers", runs: "/api/v1/ops/runs?limit=50", quality: "/api/v1/ops/quality", settings: "/api/v1/ops/settings",
  audit: "/api/v1/ops/audit", dlq: "/api/v1/ops/dlq", pipeline: "/api/v1/ops/pipeline",
};
/** 실제 요청 경로 — 실행 요약은 해결 표시(resolved=hide|show, 기본 hide)를 늘 명시한다(ADR-024) */
export const opsTabPath = (t: OpsTab, runsMode: ResolvedMode) => (t === "runs" ? `${TAB_PATH.runs}&resolved=${runsMode}` : TAB_PATH[t]);
export function opsTab<T>(t: OpsTab, runsMode: ResolvedMode, o?: Opts): Promise<T> {
  return apiGet<T>(opsTabPath(t, runsMode), o);
}

/** 요약 행을 연 실행 목록 한 쪽(errors F1) */
export interface RunsPage { items: Record<string, unknown>[]; next_cursor?: unknown }
export function runsDrill(k: RunKey, since: string | null, cursor: number | null, o?: Opts): Promise<RunsPage> {
  return apiGet<RunsPage>(runsDrillPath(k, since, cursor), o);
}

// ---- 쓰기 ----

/** 공급자 켜기 · 끄기(R-94) — 응답은 DB 원본 반영과 Redis 미러 여부 */
export function setProviderEnabled(name: string, on: boolean): Promise<ToggleResult> {
  return apiSend<ToggleResult>("POST", providerSwitchPath(name, on ? "enable" : "disable"));
}
/** 설정 저장(R-35) — ifMatch = 편집을 시작할 때 본 version(lib/ops settingIfMatch). 다른 곳에서 바뀌었으면 409 */
export function saveSetting(key: string, value: unknown, ifMatch: string): Promise<unknown> {
  return apiSend("PUT", settingPath(key), { value }, { "If-Match": ifMatch });
}
/** 해결 처리 하나(ADR-024) — 201 본문을 읽는다(형식이 틀리면 null) */
export function createResolution(d: ResolutionDraft, note: string): Promise<Resolution | null> {
  return apiSend<unknown>("POST", RESOLUTIONS_PATH, resolutionBody(d, note)).then((v) => parseResolution(v));
}
/** 해결 되돌리기(204) */
export function revokeResolution(id: number): Promise<void> {
  return apiSend<void>("DELETE", resolutionPath(id));
}
