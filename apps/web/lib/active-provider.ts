/**
 * 작업(관심 지역 region · 전세계 global)이 쓰는 공급자와 '공급자 없음' 상태(운영 로그 2026-09-30 KST 12:16:32 · 12:22:28 — 계약 v5 §G24).
 * 수집기가 wakeline:active 에 쓴 값을 api 가 그대로 싣는다(/status · WS status 의 active_providers, /ops/providers 의 active). 값은 그대로 보이고
 * 모르는 값은 짓지 않는다. 시각은 KST 만.
 * - {job}: 마지막으로 쓴 공급자 — 공급자 없음이어도 남는다(기록). 그래서 이것만 보면 쓰던 공급자가 지금도 도는 것처럼 보였다(초록 배지).
 * - {job}_none_since(UTC ISO — 공급자 없음이 시작된 때) · {job}_none_reason(건너뛴 공급자와 까닭, 수집기 글 그대로) · {job}_none_next(가장 먼저 풀리는
 *   때 — 수집기 체인 상태로 정해진 값, 운영자가 켜야 하거나 설정이 없으면 빈 값). none_since 가 비어 있으면 공급자가 있다.
 * 수집기가 멈추면 이 값을 지울 주체가 없다 — 지역 피드의 나이(STALE)가 함께 보인다.
 */
import { fmtKst, timeParts } from "./time";

export interface NoProvider {
  /** 시작(수집기 UTC ISO) — 형식이 틀리면 null(모름) */
  since: string | null;
  reason: string;
  /** 가장 먼저 풀리는 때 — 모르면 null */
  next: string | null;
}
export interface JobProvider {
  job: string;
  /** 마지막으로 쓴 공급자 — 없으면 null */
  name: string | null;
  reason: string;
  since: string | null;
  /** 공급자 없음 — 공급자가 있으면 null */
  none: NoProvider | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** 시간대가 있는 ISO 시각만(수집기는 늘 Z 로 쓴다). 아니면 null */
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && /(Z|[+-]\d\d:?\d\d)$/.test(s) && timeParts(s) ? s : null;
};

export function jobProvider(active: Record<string, string> | null | undefined, job: string): JobProvider | null {
  const noneRaw = str(active?.[`${job}_none_since`]);
  if (!active || (!(job in active) && !noneRaw)) return null; // 한 번도 고르지 못한 작업(예: 전세계 — OpenSky 설정 안 됨)도 공급자 없음이면 있다
  return {
    job, name: str(active[job]) || null, reason: str(active[`${job}_reason`]), since: iso(active[`${job}_since`]),
    none: noneRaw ? { since: iso(noneRaw), reason: str(active[`${job}_none_reason`]), next: iso(active[`${job}_none_next`]) } : null,
  };
}

const NONE_SUFFIX = "_none_since";
/** 작업들(밑줄 없는 키 · 공급자 없음이 적힌 작업 — 수집기가 쓴 순서) */
export function activeJobs(active: Record<string, string> | null | undefined): JobProvider[] {
  const jobs: string[] = [];
  for (const k of Object.keys(active ?? {})) {
    const job = !k.includes("_") ? k : k.endsWith(NONE_SUFFIX) && str(active![k]) ? k.slice(0, -NONE_SUFFIX.length) : null;
    if (job && !job.includes("_") && !jobs.includes(job)) jobs.push(job);
  }
  return jobs.map((j) => jobProvider(active, j)!);
}

/** 공급자 없음의 한 줄(title · 상세): "공급자 없음 · 12:16:32 KST 부터 — 건너뜀: … · 가장 먼저 풀리는 때 12:21:22 KST(수집기 체인 상태) · 마지막으로 쓴 공급자 adsb_lol" */
export function noProviderLine(p: JobProvider, nowMs: number): string {
  const n = p.none;
  if (!n) return "";
  const at = (v: string) => kstAt(v, nowMs);
  return [
    `공급자 없음 · ${n.since ? `${at(n.since)} 부터` : "시작 시각 모름"} — 건너뜀: ${n.reason || "—"}`,
    n.next ? `가장 먼저 풀리는 때 ${at(n.next)}(수집기 체인 상태)` : "풀리는 때 모름(운영자가 켜거나 설정해야 한다)",
    p.name ? `마지막으로 쓴 공급자 ${p.name}` : null,
  ].filter(Boolean).join(" · ");
}

/** 배지 글자: "region: 공급자 없음 · 12:16:32 KST 부터" · "region: adsb_fi" */
export function jobBadgeText(p: JobProvider, nowMs: number): string {
  if (p.none) return `${p.job}: 공급자 없음${p.none.since ? ` · ${kstAt(p.none.since, nowMs)} 부터` : ""}`;
  return `${p.job}: ${p.name ?? "—"}`;
}

/** 배지 title(공급자가 있을 때): 전환 사유 · 그때 */
export function jobBadgeTitle(p: JobProvider, nowMs: number): string {
  if (p.none) return noProviderLine(p, nowMs);
  return [p.reason || null, p.since ? `${kstAt(p.since, nowMs)} 부터` : null].filter(Boolean).join(" · ");
}

/** KST 벽시계 — 오늘(KST)이면 시각만, 아니면(또는 지금을 모르면) 날짜도 */
function kstAt(v: string, nowMs: number): string {
  const p = timeParts(v);
  const today = nowMs > 0 ? timeParts(nowMs) : null;
  return fmtKst(v, { date: !(p && today && p.wall.ymd === today.wall.ymd) });
}
