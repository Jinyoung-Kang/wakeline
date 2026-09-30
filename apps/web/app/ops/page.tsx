"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { DISPLAY_TZ, fmtKst, fmtKstClock, fmtTimeTitle, utcDayWindowKst } from "@/lib/time";
import { fmtBudgetLimit, fmtLatencyMs } from "@/lib/format";
import { liveNote, mirrorDiffers, switchCell, toggleNote, type SwitchNote, type SwitchState, type ToggleResult } from "@/lib/provider-switch";
import {
  classifyOpsError, editSetting, isAuthMiss, OPS_SESSION_PATH, parseSetting, pipelineLossCount, providerLastError, providerMissing, providersNowMs, rebaseSetting, RequestOrder, RUN_STATUS_TITLE,
  runStatusClass, SESSION_EXPIRED_NOTE, settingConflict, qualityPartialDay, settingIfMatch, settingSpec, signOut, withProviderResolutions, type SettingEdit,
} from "@/lib/ops";
import { hiddenCount, hiddenText, parseResolutionState, RESOLUTION_STATE_TEXT, RESOLVE_EFFECT, type ResolvedMode } from "@/lib/resolutions";
import { ResolveConfirm, useResolveSlot, type ResolveResult, type ResolveTarget } from "@/components/ResolveConfirm";
import { OpsLogin } from "@/components/OpsLogin";
import { OpsPipeline } from "@/components/OpsPipeline";
import { ErrorNote, RequestIdOf } from "@/components/logs/ErrorNote";
import { statsDay } from "@/lib/stats";
import { activeJobs, jobBadgeText, jobBadgeTitle } from "@/lib/active-provider";
import { KstTime } from "@/components/KstTime";

type Any = Record<string, unknown>;
/** provider_switch: 켜고 끄기의 원본(DB)과 수집기가 따르는 Redis 미러(R-94) — providers[].disabled 는 미러 값 */
/** resolution_state = 해결 기록의 상태(ok | stale | unavailable — ADR-024). providers[] 마다 last_error_resolution · last_error_resolved */
interface Providers {
  providers: Any[]; active: Record<string, string>; collector: Record<string, string>; switches: Any[]; budget_days: Any[]; budget_day_zone?: unknown; provider_switch?: SwitchState[]; resolution_state?: unknown;
  /** 응답을 만든 서버 시각(UTC ISO) — '파일 없음' 줄의 '확인 멈춤'을 서버 기준 지금으로 판정한다(providersNowMs) */
  generated_at?: unknown;
}
/** hidden_resolved_errors = 해결 처리로 요약에서 뺀 오류 실행 수(ADR-024). mode = 이 응답을 요청한 해결 표시(화면 문구는 받은 응답의 것을 말한다) */
interface Runs { items: Any[]; summary_24h: Any[]; hidden_resolved_errors?: unknown; mode: ResolvedMode }
/** counted_since = V16 이 격리 수를 KST 날짜로 세기 시작한 순간(UTC ISO) — 그 KST 날짜는 부분 값(lib/ops qualityPartialDay) */
interface Quality { rule_counts: Any[]; recent: Any[]; day_zone?: unknown; counted_since?: unknown }
interface Settings { items: { key: string; value: unknown; version: number; updated_by?: string; updated_at?: string }[] }
type Tab = "providers" | "runs" | "quality" | "settings" | "audit" | "dlq" | "pipeline";
const TABS: readonly Tab[] = ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"];
/** 탭마다 불러오는 엔드포인트 — 마지막 성공 시각·실패를 탭마다 따로 둔다(R-12) */
const TAB_PATH: Record<Tab, string> = {
  providers: "/api/v1/ops/providers", runs: "/api/v1/ops/runs?limit=50", quality: "/api/v1/ops/quality", settings: "/api/v1/ops/settings",
  audit: "/api/v1/ops/audit", dlq: "/api/v1/ops/dlq", pipeline: "/api/v1/ops/pipeline",
};
/** 실제 요청 경로 — 실행 요약은 해결 표시(resolved=hide|show, 기본 hide)를 늘 명시한다(ADR-024) */
const tabPath = (t: Tab, runsMode: ResolvedMode) => (t === "runs" ? `${TAB_PATH.runs}&resolved=${runsMode}` : TAB_PATH[t]);
/** 탭마다 요청 순서(lib/ops RequestOrder) — 대시보드마다 하나 */
const newOrders = () => Object.fromEntries(TABS.map((t) => [t, new RequestOrder()])) as Record<Tab, RequestOrder>;
/** 해결 처리 뒤 다시 읽는 탭: 공급자(해결됨 표시) · 실행 요약(오류 행) · 감사(RESOLVE · UNRESOLVE) */
const RESOLVE_AFFECTS: readonly Tab[] = ["providers", "runs", "audit"];
/** 응답 필드 → 시각 값(ISO 문자열 · epoch ms). 그 밖은 모름(null) */
const at = (v: unknown): string | number | null => (typeof v === "string" || typeof v === "number" ? v : null);
/** 격리 수 날짜 칸 머리글 — 수집기가 실행이 시작된 KST 날짜로 센다(db.py — 계약 v5 §G20, 응답 day_zone "Asia/Seoul") */
const KST_DAY_TITLE = "KST 날짜 — 수집기가 실행이 시작된 한국 표준시 날짜(00:00–24:00 KST)마다 센다 · ‘부분’ 이 붙은 날은 KST 날짜로 세기 시작한 시각 뒤의 실행만 들었다";
/** 응답이 밝힌 날짜 기준이 이 화면이 아는 것과 다를 때(옛 api 등) — 날짜를 KST 로 보이지 않고 그렇다고 말한다 */
const QUALITY_ZONE_UNKNOWN = "격리 수 응답이 KST 날짜로 센 응답이 아님(day_zone 없음 — api 가 이 화면보다 옛 판일 수 있음) — 날짜를 보이지 않음";
const BUDGET_ZONE_UNKNOWN = "예산 날의 기준을 응답이 밝히지 않음(budget_day_zone 없음 — api 가 이 화면보다 옛 판일 수 있음) — 창을 보이지 않음";
/**
 * 예산 날 칸(계약 v5 §G20): 수집기의 하루 예산 키(budget.py day_key — budget:{공급자}:{yyyymmdd})는 UTC 날로 정해져 매일 09:00 KST 에 새로 시작한다.
 * 그 날짜를 KST 날짜로 이름만 바꾸지 않고(다른 하루가 된다) 한 행의 창을 KST 로 적는다(lib/time utcDayWindowKst).
 */
const BUDGET_DAY_TITLE = "공급자 하루 예산의 한 창 — 수집기의 예산 키는 매일 09:00 KST 에 새로 시작한다(한 행 = 09:00 KST 부터 다음 날 08:59 KST 까지, KST 날짜 하루가 아니다)";
/**
 * 공급자 표의 사용량 머리글: budget_used 는 수집이 성공할 때만 쓰는 스냅숏이다(collector status.py success() 만 쓰고 failure() 는 건드리지 않는다) —
 * 실패만 이어지는 공급자(예: 429 백오프)는 이전 예산 창의 값이 남아 있을 수 있다. "지금 날짜의 호출 수" 라고 말하지 않는다.
 */
const BUDGET_USED_TITLE = "사용량 = 마지막으로 성공한 수집 때 센 호출 수(그때의 예산 창 — 매일 09:00 KST 초기화) · 실패한 호출 뒤로는 갱신되지 않아 지금 창의 값이 아닐 수 있다 · 창별 값은 아래 Daily budget snapshot";
/** 원본 칸(격리 detail · DLQ payload head · 실행 오류 글자): api 가 준 글자 그대로(data-raw) — 안의 시각은 수집기가 쓴 형식이고 화면의 KST 로 바꾸지 않는다 */
const RAW_RECORD_TITLE = "원본 그대로(바꾸지 않음) — 안의 시각은 수집기가 쓴 형식 그대로(‘…Z’ 는 KST 보다 9시간 이르다), 옆 칸의 시각은 KST";

/** 숫자 칸: 고정폭 숫자 + 한 줄("1,225 ms" 가 값 · 단위 두 줄로 갈라지지 않게 — 머리글은 줄바꿈해도 된다) */
const NUM_CELL = "mono whitespace-nowrap tabular-nums";

/** 표 칸의 시각: KST "MM-DD HH:MM:SS"(머리글 "(KST)" — lib/time), title 에 연도 · ms 까지의 KST. 모르면 "—" */
function TimeCell({ v }: { v: unknown }) {
  return <td className="whitespace-nowrap"><KstTime v={at(v)} variant="cell" /></td>;
}

const LAST_ERROR_TITLE = "수집기가 마지막으로 남긴 오류(공급자 해시 last_error · last_error_at — 다음 실패가 덮어쓴다). 해결 처리(ADR-024) = 그 오류의 시각까지 해결로 적는다: "
  + "지우지 않고 흐리게 '해결됨', 실행 요약(24 h)의 error 행에서 뺀다. 그 뒤 새 오류는 다시 보인다";
const SMALL_BTN = "btn ml-1 px-1.5! py-0! normal-case!";

/**
 * LAST ERROR 칸(ADR-024): 오류 글자 + 시각(KST) 아래에 해결 상태 — 해결됨(흐리게 "해결됨 · <by> · <upto>" + 되돌리기) ·
 * 해결 뒤 재발("이전 해결 #id(upto …) 뒤 다시 남" — 오류 시각이 upto 뒤로 확인될 때만) · 확인되지 않으면 "해결 #id 있음 — …"(시각을 몰라 재발이라 하지 않는다) ·
 * 해결 처리(upto = 그 오류의 시각 last_error_at 그대로 — 시각을 읽을 수 없으면 막는다).
 * 확인 패널은 부모가 그 행 아래에 연다(onOpen).
 */
function ProviderErrorCell({ p, onOpen, opener }: { p: Any; onOpen: (t: ResolveTarget) => void; opener: { "aria-expanded": boolean; "aria-controls": string | undefined } }) {
  const name = String(p.name);
  const le = providerLastError(p);
  const res = le.resolution;
  return (
    <td className={`max-w-[360px] ${le.resolved ? "text-fg-3" : "text-fg-2"}`} data-testid="provider-last-error">
      <div className="truncate" title={`${String(p.last_error ?? "")}${p.last_error_at ? `\n${fmtTimeTitle(at(p.last_error_at)) ?? ""}` : ""}`}>
        <span data-testid="provider-last-error-text">{String(p.last_error ?? "")} {p.last_error_at ? fmtKst(at(p.last_error_at)) : ""}</span>
      </div>
      {le.resolved && res ? (
        <div className="text-[10px]">
          <span data-testid="provider-error-resolved">해결됨 · <span className="mono">{res.resolved_by}</span> · <KstTime v={res.upto} /></span>
          <button className={SMALL_BTN} {...opener} aria-label={`되돌리기: 공급자 ${name} 해결 #${res.id}`} onClick={() => onOpen({
            op: "revoke", ref: res, effect: RESOLVE_EFFECT.revoke,
            subject: <>해결 #{res.id} · 공급자 <span className="mono">{name}</span> 오류 · upto <KstTime v={res.upto} /> · {res.resolved_by}</>,
          })}>되돌리기</button>
        </div>
      ) : le.hasError ? (
        <div className="text-[10px]">
          {le.recurred && res ? <span className="text-warn" data-testid="provider-error-recurred">이전 해결 #{res.id}(upto <KstTime v={res.upto} />) 뒤 다시 남</span>
            : le.undecided && res ? <span className="text-fg-3" data-testid="provider-error-undecided" title="api 가 이 오류를 해결됨으로 보지 않았다(last_error_resolved=false) — 재발인지는 오류 시각으로만 말한다">
              해결 #{res.id}(upto <KstTime v={res.upto} />) 있음 — {le.upto ? "api 가 그 해결이 이 오류를 덮지 않는다고 함" : "이 오류의 시각을 몰라 그 해결이 덮는지 알 수 없음"}</span>
            : null}
          <button className={SMALL_BTN} disabled={!le.upto} {...opener} aria-label={`해결 처리: 공급자 ${name} 오류`}
            title={le.upto ? "이 오류의 시각까지 이 공급자의 오류를 해결로 적는다 — 확인 창이 먼저 범위를 말한다" : "오류 시각을 모름(last_error_at 을 시각으로 읽을 수 없음) — 해결 범위(upto)를 정할 수 없음"}
            onClick={() => le.upto && onOpen({
              op: "resolve", drafts: [{ kind: "provider_error", key: name, upto: le.upto }], effect: RESOLVE_EFFECT.provider_error,
              subject: <>공급자 <span className="mono">{name}</span> 의 마지막 오류 · upto <KstTime v={le.upto} /> <span className="text-fg-3">(그 오류의 시각)</span> — <span className="mono">{String(p.last_error)}</span></>,
            })}>해결 처리</button>
        </div>
      ) : null}
    </td>
  );
}

/**
 * 운영 화면(FR-13/14/25/27): 로그인(세션) 후 공급자·실행 이력·품질 게이트·설정·감사·DLQ·파이프라인 손실 지표(R-18). 비로그인은 404 → 로그인 폼.
 * 세션이 만료되면(ops 호출 401/404 + 세션 확인도 401/404) 대시보드를 지우고 로그인으로 돌아간다. 로그아웃은 실패해도 로그인으로(R-12).
 * 시각은 KST 만(계약 v5 §G20, lib/time) 날짜 포함 — 감사·실행 이력은 날짜가 바뀌어도 모호하지 않아야 한다.
 * 표 칸은 KST "MM-DD HH:MM:SS"(머리글 "(KST)"), 그 밖의 자리는 "… KST", title 에 연도 · ms 까지의 KST. 일 단위 집계의 날짜는 아래 표마다 그 기준을 적는다.
 * 원본 칸(격리 detail · DLQ payload head · 실행 오류 글자)은 api 가 준 글자 그대로(data-raw) — 안의 시각을 바꾸지 않고 머리글이 "(raw)" 를 말한다.
 * 모르는 값은 "—"(0 으로 채우지 않는다 — 지연도 "— ms" 가 아니라 "—").
 */
export default function OpsPage() {
  const [me, setMe] = useState<{ username: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { apiGet<{ username: string }>(OPS_SESSION_PATH).then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); }, []);
  const login = useCallback((u: { username: string }) => { setNotice(null); setMe(u); }, []);
  if (!checked) return <div className="p-4 text-fg-3"><h1 className="sr-only">운영</h1>…</div>;
  return <><h1 className="sr-only">운영{me ? "" : " — 로그인"}</h1>{me ? <OpsDashboard me={me} onLeave={leave} /> : <OpsLogin onLogin={login} notice={notice} />}</>;
}

function OpsDashboard({ me, onLeave }: { me: { username: string }; onLeave: (note: string | null) => void }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [prov, setProv] = useState<Providers | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [audit, setAudit] = useState<{ items: Any[] } | null>(null);
  const [dlq, setDlq] = useState<{ items: Any[] } | null>(null);
  const [pipeline, setPipeline] = useState<unknown>(null);
  /** 마지막 오류(문구 + ApiError 면 요청 id — 계약 v5 §C8) */
  const [err, setErr] = useState<unknown>(null);
  /** 탭(엔드포인트)마다 마지막 성공 시각과 마지막 요청의 실패(성공하면 지운다) — 한 탭만 계속 실패해도 드러난다(R-12) */
  const [lastOk, setLastOk] = useState<Partial<Record<Tab, number>>>({});
  const [tabErr, setTabErr] = useState<Partial<Record<Tab, unknown>>>({});
  /** 실행 요약의 해결 표시(ADR-024): hide(기본) = 해결 처리한 공급자 오류의 error 실행을 요약에서 뺀다 · show = 뺀 것 없이. ref 는 요청을 떠날 때의 값을 읽는다 */
  const [runsMode, setRunsMode] = useState<ResolvedMode>("hide");
  const runsModeRef = useRef<ResolvedMode>("hide");
  /**
   * 탭마다 요청 순서(lib/ops RequestOrder): 기준 요청(쓰기 뒤 · 해결 표시 토글 · 새로고침 단추) 전에 떠난 요청의 응답은 버리고 — 해결 쓰기 뒤 다시 읽은 값을
   * 그 전에 떠난 주기 요청이 덮지 않게, 토글 전 해결 표시의 요약이 표에 오지 않게 — 새로고침보다 느린 응답(실패 포함)은 더 새 응답이 없으면 반영한다.
   */
  const order = useRef<Record<Tab, RequestOrder> | null>(null);
  /** 오류 처리: 세션 만료면 로그인으로(대시보드 상태는 언마운트로 사라진다), 아니면 오류 문구 */
  const fail = useCallback((e: unknown) => {
    if (!isAuthMiss(e)) { setErr(e); return; }
    void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => (k === "expired" ? onLeave(SESSION_EXPIRED_NOTE) : setErr(e)));
  }, [onLeave]);
  /** 해결 쓰기의 401/404: 세션 확인만(문구는 확인 패널이 보인다) — 만료면 로그인으로 */
  const authMiss = useCallback(async (e: unknown) => {
    const k = await classifyOpsError(e, () => apiGet(OPS_SESSION_PATH));
    if (k === "expired") onLeave(SESSION_EXPIRED_NOTE);
    return k;
  }, [onLeave]);
  /**
   * 탭 불러오기 — only 를 주면 그 탭만(해결 쓰기 뒤 · 해결 표시 토글), 없으면 모두(15 s 주기 · 새로고침 단추).
   * periodic = 15 s 주기: 기준 요청이 아니고, 요청이 아직 떠 있는 탭은 건너뛴다. 그 밖(처음 · 새로고침 단추 · 쓰기 뒤 · 토글)은 기준 요청이다.
   */
  const reload = useCallback((only?: readonly Tab[], periodic = false) => {
    if (!only) setErr(null);
    let authMiss = false; // 한 번의 새로고침에서 세션 확인은 한 번만
    const load = <T,>(t: Tab, set: (v: T, mode: ResolvedMode) => void) => {
      if (only && !only.includes(t)) return;
      const ord = (order.current ??= newOrders())[t];
      if (periodic && ord.busy) return;
      const mode = runsModeRef.current;
      const my = ord.begin(!periodic);
      void apiGet<T>(tabPath(t, mode)).then(
        (v) => { if (!ord.settle(my)) return; set(v, mode); setLastOk((o) => ({ ...o, [t]: Date.now() })); setTabErr((m) => { const c = { ...m }; delete c[t]; return c; }); },
        (e: unknown) => {
          if (!ord.settle(my)) return;
          // 이 탭의 값은 마지막 성공 시각 기준으로 남는다 — 실패를 탭에 붙인다. 세션 만료면 로그인으로(확인은 한 번만)
          setTabErr((m) => ({ ...m, [t]: e }));
          if (!isAuthMiss(e) || authMiss) return;
          authMiss = true;
          void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
        });
    };
    load<Providers>("providers", setProv);
    load<Omit<Runs, "mode">>("runs", (v, mode) => setRuns({ ...v, mode }));
    load<Quality>("quality", setQuality);
    load<Settings>("settings", setSettings);
    load<{ items: Any[] }>("audit", setAudit);
    load<{ items: Any[] }>("dlq", setDlq);
    load<unknown>("pipeline", setPipeline);
  }, [onLeave]);
  const refresh = useCallback(() => reload(), [reload]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(() => reload(undefined, true), 15_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [refresh, reload]);
  const toggleRunsMode = () => {
    const next: ResolvedMode = runsModeRef.current === "show" ? "hide" : "show";
    runsModeRef.current = next;
    setRunsMode(next);
    reload(["runs"]);
  };
  /** 공급자 오류 해결 확인 패널(한 번에 하나 — 그 공급자 행 아래) · 마지막 해결 쓰기 결과(상태 줄) */
  const { open: resolveOpen, show: showResolve, close: closeResolve, closeIf: closeResolveIf, panelId: resolvePanelId, openerProps: resolveOpener } = useResolveSlot();
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  /**
   * 201/204 뒤: 201 은 받은 해결을 공급자 행에 바로 붙이고(낙관적 — 201 뒤에만), 204 는 붙이지 않는다(서버가 정한다). 영향받는 탭을 다시 읽는다.
   * n = 결과를 낸 패널 번호 — 그 패널이 아직 열려 있을 때만 닫는다(보내는 동안 다른 공급자의 확인을 열었으면 그대로)
   */
  const resolveChanged = useCallback((r: ResolveResult, n: number) => {
    if (r.complete) closeResolveIf(n);
    if (r.op === "resolve") {
      setProv((p) => (p ? withProviderResolutions(p, r.created) : p));
      setResolveNote(`해결 처리됨: ${r.created.map((c) => `공급자 ${c.key}(해결 #${c.id})`).join(" · ") || `${r.saved}건`} — 공급자 · 실행 요약 · 감사를 다시 불러옴`);
    } else if (r.complete) {
      setResolveNote(`되돌림: 해결 #${r.id} — 공급자 · 실행 요약 · 감사를 다시 불러옴`);
    }
    reload(RESOLVE_AFFECTS);
  }, [reload, closeResolveIf]);
  const logout = () => { void signOut(() => apiSend("DELETE", OPS_SESSION_PATH), onLeave); };
  const losses = pipelineLossCount(pipeline);
  /** 마지막 토글 결과(R-94): DB 원본에 커밋됐어도 Redis 미러에 실패했으면(mirrored=false) 수집기는 아직 이전 값을 따른다 — 경고로 보인다 */
  const [switchNote, setSwitchNote] = useState<SwitchNote | null>(null);
  const toggle = async (name: string, action: "enable" | "disable") => {
    try { setSwitchNote(toggleNote(await apiSend<ToggleResult>("POST", `/api/v1/ops/providers/${name}/${action}`))); refresh(); } catch (e) { fail(e); }
  };
  const switchMsg = liveNote(switchNote, prov?.provider_switch); // 주기 미러가 맞췄으면 경고를 내린다
  const differs = mirrorDiffers(prov?.provider_switch);
  /** 격리 수를 KST 날짜로 세기 시작한 날(V16) — 그 날짜의 행에 '부분' 을 붙인다 */
  const qualityPartial = quality?.day_zone === DISPLAY_TZ.iana ? qualityPartialDay(quality.counted_since) : null;
  return (
    <div className="flex h-full flex-col" data-testid="ops-dashboard">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-3 py-1">
        <span className="label mr-2">Operations</span>
        <div className="flex gap-1" role="group" aria-label="운영 탭">{TABS.map((t) => (
          <button key={t} className="btn" aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`ops-tab-${t}`}>
            {t}{t === "pipeline" && losses ? <span className="ml-1 text-bad" title="0 이 아닌 손실 지표 수">● {losses}</span> : null}
            {tabErr[t] ? <span className="ml-1 text-warn" title={`마지막 요청 실패 — 표시 값은 ${fmtKstClock(lastOk[t])} 기준`} data-testid="ops-tab-stale">갱신 실패</span> : null}
          </button>
        ))}</div>
        <button className="btn" onClick={refresh} title="모든 탭을 지금 다시 받는다(15 s 주기와 따로)">새로고침</button>
        <span className={`mono text-[11px] ${tabErr[tab] ? "text-warn" : "text-fg-3"}`} title={`이 탭(${tabPath(tab, runsMode)})의 마지막 성공 응답 시각(KST) — 15 s 마다 다시 요청${lastOk[tab] ? ` · ${fmtTimeTitle(lastOk[tab])}` : ""}`} data-testid="ops-last-ok">갱신 {fmtKstClock(lastOk[tab])}</span>
        {err || TABS.some((t) => tabErr[t]) ? (
          <span className="text-[11px] text-bad" role="alert">
            {TABS.filter((t) => tabErr[t]).map((t, i) => <span key={t}>{i ? " · " : ""}<ErrorNote prefix={`${t}: `} error={tabErr[t]} /></span>)}
            {err ? <>{TABS.some((t) => tabErr[t]) ? " · " : ""}<ErrorNote error={err} /></> : null}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-fg-3">{me.username}</span><button className="btn" onClick={logout}>sign out</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px]">
        {tab === "providers" && prov ? <>
          <div className="mb-2 flex flex-wrap gap-3 text-[11px]">
            {/* 작업별 공급자 — 공급자 없음(수집기 {job}_none_*, 운영 로그 2026-09-30)이면 빨간 배지와 까닭. 전에는 마지막으로 쓴 공급자를 초록으로 보였다 */}
            {activeJobs(prov.active).map((j) => <span key={j.job} className={`badge ${j.none ? "bad" : "ok"}`} title={jobBadgeTitle(j, providersNowMs(prov))} data-testid={`ops-active-${j.job}`}>{jobBadgeText(j, providersNowMs(prov))}</span>)}
            {Object.entries(prov.collector ?? {}).filter(([k]) => k.endsWith("_at")).map(([k, v]) => <span key={k} className="mono text-fg-3" title={`${k} — 이 작업이 마지막으로 보고한 시각(collector heartbeat)${fmtTimeTitle(at(v)) ? ` · ${fmtTimeTitle(at(v))}` : ""}`}>{k.replace("_at", "")} {fmtKst(at(v))}</span>)}
            {prov.collector?.fixture === "1" ? <span className="badge warn">FIXTURE</span> : null}
          </div>
          <div role="status" aria-live="polite">{switchMsg?.ok ? <div className="mb-2 text-[11px] text-ok" data-testid="switch-ok">{switchMsg.text}</div> : null}</div>
          {switchMsg && !switchMsg.ok ? <div className="mb-2 text-[11px] text-warn" role="alert" data-testid="switch-unmirrored">{switchMsg.text}</div> : null}
          {differs.length ? (
            <div className="mb-2 text-[11px] text-warn" role="alert" data-testid="switch-mirror-differs">
              Redis 미러가 DB 원본과 다름 — 수집기는 Redis 값을 따른다: {differs.join(", ")} · api 가 60 s 주기로 원본을 다시 미러한다
            </div>
          ) : null}
          <div role="status" aria-live="polite">{resolveNote ? <div className="mb-2 text-[11px] text-ok" data-testid="resolve-ok">{resolveNote}</div> : null}</div>
          {(() => { const s = parseResolutionState(prov.resolution_state); return s && s !== "ok" ? <div className="mb-2 text-[11px] text-warn" data-testid="ops-resolution-state">{RESOLUTION_STATE_TEXT[s]}</div> : null; })()}
          <table><thead><tr><th>provider</th><th>last success (KST)</th><th>latency</th><th>records</th><th>fails</th><th title={BUDGET_USED_TITLE}>budget used / limit</th><th>remaining (hdr)</th><th title={LAST_ERROR_TITLE}>last error</th><th title="켜고 끄기 — 원본은 DB provider_switch, 수집기는 Redis 미러를 따른다">switch · DB → Redis</th></tr></thead>
            <tbody>{prov.providers.map((p) => { const sw = prov.provider_switch?.find((x) => x.provider === String(p.name)); const cell = switchCell(sw); const off = sw?.disabled ?? p.disabled === "1";
              const miss = providerMissing(p, providersNowMs(prov)); return <Fragment key={String(p.name)}><tr>
              <td className="mono">{String(p.name)}{off ? <span className="badge bad ml-1" title={sw?.disabled != null ? "원본(DB) 기준" : "Redis 미러 기준(원본 행 없음)"}>disabled</span> : null}</td>
              <TimeCell v={p.last_success_at} /><td className={NUM_CELL}>{fmtLatencyMs(p.last_latency_ms)}</td><td className={NUM_CELL}>{String(p.last_records ?? "—")}</td>
              <td className={`${NUM_CELL} ${Number(p.consecutive_failures) > 0 ? "text-warn" : ""}`}>{String(p.consecutive_failures ?? "—")}</td>
              <td className={NUM_CELL} title="한도 — = 아직 보고되지 않음(성공한 수집이 없음) · ∞ = 한도 0(설정상 무제한)">{String(p.budget_used ?? "—")} / {fmtBudgetLimit(p.budget_limit)}</td><td className={NUM_CELL}>{String(p.budget_remaining ?? "—")}</td>
              <ProviderErrorCell p={p} onOpen={(target) => showResolve(String(p.name), target)} opener={resolveOpener(String(p.name))} />
              <td className="whitespace-nowrap" title={cell.title} data-testid="provider-switch"><span className="mono">{cell.source}</span> <span className={`badge ${cell.tone}`}>{cell.mirror}</span>{" "}
                {off ? <button className="btn" onClick={() => toggle(String(p.name), "enable")}>enable</button> : <button className="btn" onClick={() => toggle(String(p.name), "disable")}>disable</button>}</td>
            </tr>
            {/* 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30) — 호출은 성공해도 새 프레임이 오지 않는 까닭. 수집기는 그동안 last success 를 갱신하지 않는다 */}
            {miss ? <tr data-testid="provider-missing"><td colSpan={9} className="text-[11px] text-warn" title={miss.title}>
              <span aria-hidden="true">▲ </span>{miss.text} — 그동안 수집 실행은 &apos;missing&apos;(저장한 프레임 없음), last success 는 프레임을 저장했거나 새 tm 이 없던 마지막 주기</td></tr> : null}
            {resolveOpen?.at === String(p.name) ? <tr><td colSpan={9}>
              <ResolveConfirm key={resolveOpen.n} id={resolvePanelId(resolveOpen.at)} target={resolveOpen.target} onClose={closeResolve} onChanged={(r) => resolveChanged(r, resolveOpen.n)} onAuthMiss={authMiss} />
            </td></tr> : null}</Fragment>; })}</tbody></table>
          <div className="label mt-4 mb-1" title="수집기가 스스로 한 공급자 전환(wakeline:events) — 위 표의 수동 켜고 끄기와 다르다">Provider switches (collector 자동 전환)</div>
          <table><thead><tr><th>at (KST)</th><th>job</th><th>from → to</th><th>reason</th></tr></thead><tbody>{prov.switches.map((s, i) => <tr key={i}><TimeCell v={s.at} /><td>{String(s.job)}</td><td className="mono">{String(s.from)} → {String(s.to)}</td><td>{String(s.reason)}</td></tr>)}</tbody></table>
          <div className="label mt-4 mb-1">Daily budget snapshot</div>
          {prov.budget_days.length && prov.budget_day_zone !== "UTC" ? <div className="mb-1 text-[11px] text-warn" role="alert" data-testid="budget-zone-unknown">{BUDGET_ZONE_UNKNOWN}</div> : null}
          <table><thead><tr><th title={BUDGET_DAY_TITLE}>budget window (KST)</th><th>provider</th><th>calls</th><th>limit</th></tr></thead><tbody>{prov.budget_days.map((b, i) => <tr key={i}><td className="mono whitespace-nowrap" data-testid="budget-window">{(prov.budget_day_zone === "UTC" ? utcDayWindowKst(statsDay(b.day)) : null) ?? "—"}</td><td>{String(b.provider)}</td><td className="mono">{String(b.calls)}</td><td className="mono">{String(b.limit_value)}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "runs" && runs ? <>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="label">Last 24 h</span>
            <button className="btn normal-case!" aria-pressed={runsMode === "show"} onClick={toggleRunsMode} data-testid="runs-show-resolved"
              title="해결 처리한 공급자 오류(upto 이하)의 error 실행 — 끄면(기본) 요약에서 빼고 수만 보인다, 켜면 빼지 않는다. 아래 실행 기록은 늘 그대로">해결된 오류 포함</button>
            <span className="text-[11px] text-fg-3" data-testid="runs-hidden-resolved" title="해결 처리(ADR-024)는 지우지 않는다 — 실행 기록(ingest_run)은 그대로이고 요약의 셈 · 마지막 시각 · 평균에서만 뺀다">
              {runs.mode === "show" ? "해결된 오류 포함(요약에서 빼지 않음)" : `해결 처리로 요약에서 뺀 오류 실행 ${hiddenText(hiddenCount(runs.hidden_resolved_errors))} · 아래 실행 기록(Recent runs)은 가리지 않음`}
            </span>
          </div>
          <table className="mb-4"><thead><tr><th>job</th><th>provider</th><th>status</th><th>n</th><th>avg latency</th><th>last (KST)</th></tr></thead><tbody>{runs.summary_24h.map((s, i) => <tr key={i} data-testid="runs-summary-row"><td>{String(s.job)}</td><td>{String(s.provider)}</td><td className={runStatusClass(s.status, "summary")} title={RUN_STATUS_TITLE[String(s.status)]}>{String(s.status)}</td><td className="mono">{String(s.n)}</td><td className={NUM_CELL}>{fmtLatencyMs(s.avg_latency_ms)}</td><TimeCell v={s.last_at} /></tr>)}</tbody></table>
          <div className="label mb-1">Recent runs (errors masked, copy raw)</div>
          <table><thead><tr><th>id</th><th>job</th><th>provider</th><th>started (KST)</th><th>status</th><th>http</th><th>ms</th><th>in / quarantined</th><th>raw_ref</th><th>error</th></tr></thead>
            <tbody>{runs.items.map((r) => <tr key={String(r.id)}><td className="mono">{String(r.id)}</td><td>{String(r.job)}</td><td>{String(r.provider)}</td><TimeCell v={r.started_at} /><td className={runStatusClass(r.status, "item")} title={RUN_STATUS_TITLE[String(r.status)]}>{String(r.status)}</td><td className="mono">{String(r.http_status ?? "")}</td><td className="mono">{r.latency_ms == null ? "—" : String(r.latency_ms)}</td><td className="mono">{String(r.records_in)} / {String(r.records_quarantined)}</td><td className="mono text-fg-3">{String(r.raw_ref ?? "")}</td><td>{r.error_text ? <pre className="mono max-w-[360px] whitespace-pre-wrap text-[10px] text-fg-2" title={RAW_RECORD_TITLE} data-raw="record">{String(r.error_text)}</pre> : null}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "quality" && quality ? <>
          <div className="label mb-1">Quarantine counts by rule (7d)</div>
          {quality.rule_counts.length && quality.day_zone !== DISPLAY_TZ.iana ? <div className="mb-1 text-[11px] text-warn" role="alert" data-testid="quality-zone-unknown">{QUALITY_ZONE_UNKNOWN}</div> : null}
          <table className="mb-4"><thead><tr><th title={KST_DAY_TITLE}>day (KST)</th><th>rule</th><th>count</th></tr></thead><tbody>{quality.rule_counts.map((r, i) => { const day = quality.day_zone === DISPLAY_TZ.iana ? statsDay(r.day) : null; const partial = day != null && qualityPartial?.day === day ? qualityPartial : null; return <tr key={i}><td className="mono">{day ?? "—"}{partial ? <span className="badge warn ml-1 whitespace-nowrap" title={partial.title} data-testid="quality-partial-day">{partial.text}</span> : null}</td><td>{String(r.rule)}</td><td className="mono">{String(r.count)}</td></tr>; })}</tbody></table>
          <div className="label mb-1">Recent quarantined records (not shown on map, kept in raw)</div>
          <table><thead><tr><th>at (KST)</th><th>run</th><th>rule</th><th>hex</th><th title={`격리 규칙이 남긴 detail JSON — ${RAW_RECORD_TITLE}`}>detail (raw)</th></tr></thead><tbody>{quality.recent.map((r) => <tr key={String(r.id)}><TimeCell v={r.created_at} /><td className="mono">{String(r.run_id)}</td><td>{String(r.rule)}</td><td className="mono">{String(r.hex ?? "")}</td><td className="mono text-fg-3" data-raw="record">{String(r.detail)}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "pipeline" && pipeline ? <OpsPipeline data={pipeline} /> : null}
        {tab === "settings" && settings ? <SettingsForm items={settings.items} onSaved={refresh} onAuthMiss={fail} /> : null}
        {tab === "audit" && audit ? <table><thead><tr><th>at (KST)</th><th>user</th><th>action</th><th>target</th><th>before</th><th>after</th><th>ip</th><th>request</th></tr></thead>
          <tbody>{audit.items.map((a) => <tr key={String(a.id)}><TimeCell v={a.at} /><td>{String(a.username ?? "")}</td><td>{String(a.action)}</td><td className="mono">{String(a.target ?? "")}</td><td className="mono text-fg-3">{String(a.before ?? "")}</td><td className="mono">{String(a.after ?? "")}</td><td className="mono">{String(a.ip ?? "")}</td><td className="mono text-fg-3">{String(a.request_id ?? "")}</td></tr>)}</tbody></table> : null}
        {tab === "dlq" && dlq ? (dlq.items.length ? <table><thead><tr><th>at (KST)</th><th>stream</th><th>kind</th><th>reason</th><th title={`스트림 메시지 앞 200자 — ${RAW_RECORD_TITLE}`}>payload head (raw)</th></tr></thead>
          <tbody>{dlq.items.map((d) => <tr key={String(d.stream_id)}><TimeCell v={d.at} /><td className="mono">{String(d.source_stream)}</td><td>{String(d.kind)}</td><td className="text-bad">{String(d.reason)}</td><td className="mono text-fg-3" data-raw="record">{String(d.payload_head)}</td></tr>)}</tbody></table> : <div className="text-fg-3">스키마 검증에 실패한 메시지가 없습니다.</div>) : null}
      </div>
    </div>
  );
}

function SettingsForm({ items, onSaved, onAuthMiss }: { items: Settings["items"]; onSaved: () => void; onAuthMiss: (e: unknown) => void }) {
  // 편집 값과 편집을 시작할 때 본 version(R-35): 15 s 새로고침이 version 을 바꿔도 저장은 처음 본 version 으로 If-Match 한다
  const [edit, setEdit] = useState<Record<string, SettingEdit>>({});
  // 결과 문구: 성공(ok, role=status)과 실패(bad, role=alert)를 색·역할로 구분한다(R-56). 서버 실패는 요청 id(복사 — 계약 v5 §C8)를 붙인다
  const [msg, setMsg] = useState<{ ok: boolean; text: string; error?: unknown } | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const drop = (k: string) => setEdit((e) => { const c = { ...e }; delete c[k]; return c; });
  const save = async (k: string) => {
    const ed = edit[k];
    if (ed === undefined) return;
    // 서버 검증 규칙(SettingsService.validate)을 보내기 전에 — 규칙을 모르는 키는 서버가 검사
    const parsed = parseSetting(k, ed.value);
    if (!parsed.ok) { setFieldErr((f) => ({ ...f, [k]: parsed.error })); setMsg({ ok: false, text: `${k}: 저장하지 않음 — ${parsed.error}` }); return; }
    setFieldErr((f) => { const c = { ...f }; delete c[k]; return c; });
    try { await apiSend("PUT", `/api/v1/ops/settings/${k}`, { value: parsed.value }, { "If-Match": settingIfMatch(ed) }); setMsg({ ok: true, text: `${k} 저장됨 — 다음 주기부터 적용` }); drop(k); onSaved(); }
    catch (e) {
      if (isAuthMiss(e)) onAuthMiss(e);
      const conflict = e instanceof ApiError && e.status === 409;
      const text = conflict ? "편집하는 동안 다른 곳에서 바뀌었습니다 — 새 값을 확인한 뒤 다시 저장하세요"
        : e instanceof ApiError && e.status === 400 ? `서버가 값을 거절했습니다(${e.message})`
        : e instanceof ApiError ? `저장 실패(HTTP ${e.status})` : "서버에 연결할 수 없습니다(네트워크)";
      setMsg({ ok: false, text: `${k}: ${text}`, error: e });
      if (conflict) onSaved(); // 새 값·version 을 바로 받아 충돌 표시
    }
  };
  return (
    <div>
      <div className="mb-2 text-[11px] text-fg-3">변경은 If-Match(version) 낙관적 잠금 + CSRF 헤더로 보호되며 감사 로그에 남습니다. collector 는 다음 주기에 반영합니다. 편집하는 동안 서버 값이 바뀌면 행에 표시하고, 덮어쓰기는 직접 골라야 합니다.</div>
      <div className="mb-2 text-[11px] text-fg-3"><span className="mono">ais_bboxes</span>: 선박 수신 영역 <span className="mono">lat1,lon1,lat2,lon2</span>(여러 상자는 <span className="mono">;</span>) · 비우면 .env <span className="mono">AIS_BBOXES</span> · 전세계 <span className="mono">-90,-180,90,180</span> · ais 가 30 s 안에 같은 연결로 다시 구독합니다.</div>
      <div role="status" aria-live="polite">{msg?.ok ? <div className="mb-2 text-[11px] text-ok" data-testid="settings-ok">{msg.text}</div> : null}</div>
      {msg && !msg.ok ? <div className="mb-2 text-[11px] text-bad" role="alert" data-testid="settings-error">{msg.text}<RequestIdOf error={msg.error} /></div> : null}
      <table><thead><tr><th>key</th><th>value</th><th>version</th><th>updated (KST)</th><th></th></tr></thead>
        <tbody>{items.map((s) => {
          const ed = edit[s.key];
          const conflict = settingConflict(ed, s);
          return <tr key={s.key} data-testid="setting-row" data-conflict={conflict ? "true" : undefined}><td className="mono">{s.key}</td>
            <td>
              <SettingInput k={s.key} value={ed?.value ?? String(s.value)} error={fieldErr[s.key] ?? null} onChange={(v) => setEdit({ ...edit, [s.key]: editSetting(ed, s, v) })} />
              {conflict && ed ? (
                <div className="mt-1 text-[11px] text-warn" role="alert" data-testid="setting-conflict">
                  편집하는 동안 서버 값이 바뀜(v{ed.version} → v{s.version}: <span className="mono">{String(s.value)}</span>)
                  <button className="btn ml-1" onClick={() => drop(s.key)}>새 값 보기</button>
                  <button className="btn ml-1" onClick={() => setEdit({ ...edit, [s.key]: rebaseSetting(ed, s) })}>내 값으로 덮어쓰기</button>
                </div>
              ) : null}
            </td>
            <td className="mono">{s.version}</td><td className="text-fg-3"><span className="mono">{s.updated_by ?? "—"}</span> <KstTime v={s.updated_at} variant="cell" /></td>
            <td><button className="btn" onClick={() => save(s.key)} disabled={ed === undefined || conflict} title={conflict ? "서버 값이 바뀜 — 새 값 보기 또는 덮어쓰기를 먼저 고르세요" : undefined}>save</button></td></tr>;
        })}</tbody></table>
    </div>
  );
}

/** 키별 입력(R-56): 정수 → number(min/max), 켜기/끄기 → checkbox, 형식이 정해진 문자열 → text + 형식 안내. 값은 문자열로 편집한다(R-35 편집 상태). */
function SettingInput({ k, value, error, onChange }: { k: string; value: string; error: string | null; onChange: (v: string) => void }) {
  const spec = settingSpec(k);
  const describedBy = error ? `setting-err-${k}` : spec && spec.kind !== "bool" ? `setting-hint-${k}` : undefined;
  const common = { "aria-label": `${k} 값`, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  return (
    <div>
      {spec?.kind === "bool" ? (
        <label className="flex items-center gap-2"><input type="checkbox" {...common} checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} /><span className="mono">{value === "true" ? "켜짐" : "꺼짐"}</span></label>
      ) : spec?.kind === "int" ? (
        <input type="number" className="mono w-40" {...common} min={spec.min} max={spec.max} step={1} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="mono w-72 max-w-full" {...common} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {spec && spec.kind !== "bool" && !error ? <div id={`setting-hint-${k}`} className="text-[10px] text-fg-3">{spec.kind === "int" ? `정수 ${spec.min}–${spec.max} ${spec.unit}` : spec.hint}</div> : null}
      {error ? <div id={`setting-err-${k}`} className="text-[11px] text-bad">{error}</div> : null}
    </div>
  );
}
