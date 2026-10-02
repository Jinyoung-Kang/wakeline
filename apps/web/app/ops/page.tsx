"use client";
import { Fragment, useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { opsSession, opsTabPath, saveSetting, setProviderEnabled, signOutRequest, type OpsTab } from "@/lib/endpoints/ops";
import { DISPLAY_TZ, fmtKst, fmtKstClock, fmtTimeTitle, utcDayWindowKst } from "@/lib/time";
import { fmtBudgetLimit, fmtLatencyMs } from "@/lib/format";
import { liveNote, mirrorDiffers, switchCell, toggleNote, type SwitchNote } from "@/lib/provider-switch";
import {
  classifyOpsError, editSetting, isAuthMiss, parseSetting, pipelineLossCount, providerLastError, providerMissing, providersNowMs, rebaseSetting,
  RUN_STATUS_TITLE, runStatusClass, runStatusTone, SESSION_EXPIRED_NOTE, settingConflict, qualityPartialDay, settingIfMatch, settingSpec, signOut, switchHistoryError, dlqReadError, withProviderResolutions,
  type SettingEdit,
} from "@/lib/ops";
import { hiddenCount, hiddenText, parseResolutionState, RESOLUTION_STATE_TEXT, RESOLVE_EFFECT, type ResolvedMode } from "@/lib/resolutions";
import { ResolveConfirm, useResolveSlot, type ResolveResult, type ResolveTarget } from "@/components/ResolveConfirm";
import { OpsLogin } from "@/components/OpsLogin";
import { useOpsSession } from "@/components/ops/useOpsSession";
import { OPS_TABS, useOpsTabs, type Runs, type Settings } from "@/components/ops/useOpsTabs";
import { useAuditPages } from "@/components/ops/useAuditPages";
import { OpsSessionError } from "@/components/ops/OpsSessionError";
import { OpsPipeline } from "@/components/OpsPipeline";
import { ErrorNote, RequestIdOf } from "@/components/logs/ErrorNote";
import { statsDay } from "@/lib/stats";
import { activeJobs, jobBadgeText, jobBadgeTitle } from "@/lib/active-provider";
import { KstTime } from "@/components/KstTime";
import { TrafficGridFill } from "@/components/TrafficGridFill";
import { OpsRunsDrill } from "@/components/OpsRunsDrill";
import { drillGoneText, runKeyId, runKeyOf, summaryHasKey, summaryLastError, summarySince, type RunKey } from "@/lib/ops-runs";
import { AUDIT_PAGE_LIMIT } from "@/lib/ops-audit";
import { useFocusRescue } from "@/lib/use-focus-rescue";
import { useScrollFocusable } from "@/lib/use-scroll-focusable";

type Any = Record<string, unknown>;
/** 연 요약 행: 열쇠와 연 때의 summary_since(목록의 창) */
interface Drill { k: RunKey; since: string | null }
/** 탭 = 엔드포인트 하나 — 불러오기 · 순서 · 주기는 components/ops/useOpsTabs */
type Tab = OpsTab;
const TABS = OPS_TABS;
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
/**
 * 감사의 before · after 칸(QA-311): api 가 기록한 변경 전 · 후 값(JSON 글자) 그대로 — 안의 시각은 서버 형식 UTC('…Z')라 다른 원본 칸처럼 data-raw ·
 * 머리글 "(raw)" · 이 툴팁으로 KST 규칙의 예외임을 밝힌다(계약 v5 §G20). 글자는 바꾸지 않는다
 */
const AUDIT_RAW_TITLE = "api 가 기록한 변경 전 · 후 값(JSON) 그대로(바꾸지 않음) — 안의 시각은 서버 형식(‘…Z’ 는 KST 보다 9시간 이르다), 옆 칸의 시각은 KST";
/** 요약의 마지막 오류 칸(errors F1 — api last_error_text · last_http_status) */
const SUMMARY_LAST_ERROR_TITLE = "이 행의 가장 최근 실행(last (KST) 의 실행 — 해결 처리로 요약에서 뺀 실행은 고르지 않는다)의 http 와 오류 글자. "
  + "글자는 수집기가 가려 저장한 원본 그대로(안의 ‘…Z’ 는 KST 보다 9시간 이르다). ok 행은 비운다. 앞선 실행의 글자는 행을 열어(runs) 본다";
/** 요약 행을 여는 단추 칸 */
const SUMMARY_OPEN_TITLE = "행을 열면 그 job · provider · status 의 실행을 지금 요약의 24 h 창(연 때의 창 — 목록은 15 s 새로고침을 따라가지 않는다)에서 최신순으로 50건씩(더 보기) — 해결 처리와 상관없이 모두";
/** 열린 요약 행의 목록 패널 id(한 번에 하나) */
const RUNS_DRILL_ID = "runs-drill-panel";

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
 * 원본 칸(격리 detail · DLQ payload head · 실행 오류 글자 · 감사 before · after)은 api 가 준 글자 그대로(data-raw) — 안의 시각을 바꾸지 않고 머리글이 "(raw)" 를 말한다.
 * 모르는 값은 "—"(0 으로 채우지 않는다 — 지연도 "— ms" 가 아니라 "—").
 */
export default function OpsPage() {
  const { me, checked, notice, error, leave, login, retry } = useOpsSession();
  if (checked && error) return <OpsSessionError title="운영" error={error} onRetry={retry} />;
  if (!checked) return <div className="p-4 text-fg-3"><h1 className="sr-only">운영</h1>…</div>;
  return <><h1 className="sr-only">운영{me ? "" : " — 로그인"}</h1>{me ? <OpsDashboard me={me} onLeave={leave} /> : <OpsLogin onLogin={login} notice={notice} />}</>;
}

function OpsDashboard({ me, onLeave }: { me: { username: string }; onLeave: (note: string | null) => void }) {
  const [tab, setTab] = useState<Tab>("providers");
  /** 연 요약 행(한 번에 하나) — k 는 연 때 만든 객체 그대로(목록이 15 s 새로고침마다 다시 부르지 않게), since 는 연 때의 summary_since */
  const [drill, setDrillState] = useState<Drill | null>(null);
  /** 연 행이 새로 받은 요약에서 빠져 닫은 목록(알림 — 그 응답의 해결 표시와 함께). 행을 열거나 닫거나 알림을 닫으면 지운다 */
  const [drillGone, setDrillGone] = useState<{ k: RunKey; mode: ResolvedMode } | null>(null);
  /** 연 행 — 요약 응답을 받을 때 본다(탭 불러오기는 한 번 만든 콜백이라 state 대신 ref 로 지금 값을 읽는다) */
  const drillRef = useRef<Drill | null>(null);
  const setDrill = useCallback((d: Drill | null) => { drillRef.current = d; setDrillState(d); setDrillGone(null); }, []);
  /** 연 행이 새 요약에 없으면(창 밖 · 해결로 모두 가려짐) 목록을 닫고 알린다 — 말없이 사라졌다가 행이 돌아오면 저절로 다시 열려 다시 부르지 않게(리뷰 2026-10-01) */
  const onRuns = useCallback((v: Omit<Runs, "mode">, mode: ResolvedMode) => {
    const d = drillRef.current;
    if (d && !summaryHasKey(v.summary_24h, d.k)) { drillRef.current = null; setDrillState(null); setDrillGone({ k: d.k, mode }); }
  }, []);
  const {
    providers: prov, setProviders: setProv, runs, quality, settings, audit, dlq, pipeline, err, fail, lastOk, tabErr, runsMode, toggleRunsMode, reload, refresh,
  } = useOpsTabs({ onLeave, onRuns });
  /** 해결 쓰기의 401/404: 세션 확인만(문구는 확인 패널이 보인다) — 만료면 로그인으로 */
  const authMiss = useCallback(async (e: unknown) => {
    const k = await classifyOpsError(e, () => opsSession());
    if (k === "expired") onLeave(SESSION_EXPIRED_NOTE);
    return k;
  }, [onLeave]);
  /** 감사 탭: 첫 쪽(15 s 주기) + '더 보기'로 쌓은 앞 기록(QA-307) */
  const auditPages = useAuditPages(audit, (e) => { void authMiss(e); });
  /**
   * 누른 단추가 사라지는 조작(감사 '더 보기' — 끝 쪽을 받으면 사라짐, 실행 목록 '닫기') 뒤 초점(WCAG 2.4.3 — QA-304): 초점이 body 로 떨어졌으면
   * 탭 본문으로, 실행 목록을 닫으면 그 행의 '실행' 단추로(lib/use-focus-rescue — 잃었을 때만). '더 보기'는 받는 동안 disabled 가 아니라 aria-disabled
   * (초점을 지닌 채 쉰다 — 두 번 누름은 useAuditPages 가 막는다)
   */
  const tabBody = useRef<HTMLDivElement>(null);
  const auditMore = useRef<HTMLButtonElement>(null);
  const drillOpener = useRef<HTMLElement | null>(null);
  const rescue = useFocusRescue(10_000);
  const tabScroll = useScrollFocusable<HTMLDivElement>();
  const tabBodyRef = useCallback((el: HTMLDivElement | null) => { tabBody.current = el; return tabScroll(el); }, [tabScroll]);
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
  }, [reload, closeResolveIf, setProv]);
  const logout = () => { void signOut(() => signOutRequest(), onLeave); };
  const losses = pipelineLossCount(pipeline);
  /** 마지막 토글 결과(R-94): DB 원본에 커밋됐어도 Redis 미러에 실패했으면(mirrored=false) 수집기는 아직 이전 값을 따른다 — 경고로 보인다 */
  const [switchNote, setSwitchNote] = useState<SwitchNote | null>(null);
  /**
   * 응답을 기다리는 공급자 켜고 끄기 — 공급자마다 한 번만(두 번 누르면 POST 두 번 · 감사 행 두 개였다). ref 는 같은 프레임의 두 번째 누름을,
   * state 는 단추의 바쁨(disabled · aria-busy)을 맡는다
   */
  const switching = useRef(new Set<string>());
  const [busySwitch, setBusySwitch] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 마지막 켜고 끄기 실패(PLAN §5 결정 4): 다음 쓰기나 '알림 닫기' 전까지 둔다 — 15 s 주기 · 새로고침 단추가 지우지 않는다(지우면 공급자가 꺼지지 않았다는 것을
   * 놓친다, web-review B4). 세션 만료(401/404 + 세션 확인도 401/404)면 로그인으로
   */
  const [switchErr, setSwitchErr] = useState<{ name: string; action: "enable" | "disable"; error: unknown } | null>(null);
  /**
   * 설정 저장의 마지막 결과 문구(PLAN §5 결정 4 — 실패는 다음 저장이나 '알림 닫기' 전까지). 폼은 settings 탭에서만 그려지므로 대시보드에 둔다 —
   * 폼 안에 두면 다른 탭에 다녀오는 것만으로 실패가 사라졌다(리뷰 cto-2026-10 최종)
   */
  const [settingsMsg, setSettingsMsg] = useState<SettingsMsg | null>(null);
  const toggle = async (name: string, action: "enable" | "disable") => {
    if (switching.current.has(name)) return;
    switching.current.add(name);
    setBusySwitch(new Set(switching.current));
    setSwitchErr(null);
    try { setSwitchNote(toggleNote(await setProviderEnabled(name, action === "enable"))); refresh(); }
    catch (e) { setSwitchErr({ name, action, error: e }); if (isAuthMiss(e)) void authMiss(e); }
    finally { switching.current.delete(name); setBusySwitch(new Set(switching.current)); }
  };
  const switchMsg = liveNote(switchNote, prov?.provider_switch); // 주기 미러가 맞췄으면 경고를 내린다
  const differs = mirrorDiffers(prov?.provider_switch);
  /** 격리 수를 KST 날짜로 세기 시작한 날(V16) — 그 날짜의 행에 '부분' 을 붙인다 */
  const qualityPartial = quality?.day_zone === DISPLAY_TZ.iana ? qualityPartialDay(quality.counted_since) : null;
  return (
    <div className="flex h-full flex-col" data-testid="ops-dashboard">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-3 py-1">
        <span className="label mr-2">Operations</span>
        {/* 좁은 화면(375 · 320 px)에서는 탭 줄이 줄바꿈한다 — 전에는 한 줄로 화면 밖에 넘쳐 audit · dlq · pipeline 을 누를 수 없었다(QA-302, WCAG 1.4.10) */}
        <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label="운영 탭">{TABS.map((t) => (
          <button key={t} className="btn" aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`ops-tab-${t}`} data-session-focus={tab === t || undefined}>
            {t}{t === "pipeline" && losses ? <span className="ml-1 text-bad" title="0 이 아닌 손실 지표 수">● {losses}</span> : null}
            {tabErr[t] ? <span className="ml-1 text-warn" title={`마지막 요청 실패 — 표시 값은 ${fmtKstClock(lastOk[t])} 기준`} data-testid="ops-tab-stale">갱신 실패</span> : null}
          </button>
        ))}</div>
        <button className="btn" onClick={refresh} title="모든 탭을 지금 다시 받는다(15 s 주기와 따로)">새로고침</button>
        <span className={`mono text-[11px] ${tabErr[tab] ? "text-warn" : "text-fg-3"}`} title={`이 탭(${opsTabPath(tab, runsMode)})의 마지막 성공 응답 시각(KST) — 15 s 마다 다시 요청${lastOk[tab] ? ` · ${fmtTimeTitle(lastOk[tab])}` : ""}`} data-testid="ops-last-ok">갱신 {fmtKstClock(lastOk[tab])}</span>
        {err || TABS.some((t) => tabErr[t]) ? (
          <span className="text-[11px] text-bad" role="alert">
            {TABS.filter((t) => tabErr[t]).map((t, i) => <span key={t}>{i ? " · " : ""}<ErrorNote prefix={`${t}: `} error={tabErr[t]} /></span>)}
            {err ? <>{TABS.some((t) => tabErr[t]) ? " · " : ""}<ErrorNote error={err} /></> : null}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-fg-3">{me.username}</span><button className="btn" onClick={logout} lang="en">sign out</button>
      </div>
      {/* 탭 본문: 넘칠 때만 Tab 정지점(QA-305 — quality · audit · pipeline 은 글자뿐이라 키보드로 스크롤할 길이 없었다), 아니면 -1(초점 되살리기 자리) */}
      <div ref={tabBodyRef} className="min-h-0 flex-1 overflow-auto p-3 text-[12px]" role="region" aria-label={`${tab} 탭`} data-testid="ops-tab-body">
        {tab === "providers" && prov ? <>
          <div className="mb-2 flex flex-wrap gap-3 text-[11px]">
            {/* 작업별 공급자 — 공급자 없음(수집기 {job}_none_*, 운영 로그 2026-09-30)이면 빨간 배지와 까닭. 전에는 마지막으로 쓴 공급자를 초록으로 보였다 */}
            {activeJobs(prov.active).map((j) => <span key={j.job} className={`badge ${j.none ? "bad" : "ok"}`} title={jobBadgeTitle(j, providersNowMs(prov))} data-testid={`ops-active-${j.job}`}>{jobBadgeText(j, providersNowMs(prov))}</span>)}
            {/* 채우기 시각 둘(traffic_grid_fill_pass_at · _resume_at)은 아래 채우기 줄에서 뜻과 함께 보인다 — 작업 heartbeat 칩으로 겹쳐 적지 않는다 */}
            {Object.entries(prov.collector ?? {}).filter(([k]) => k.endsWith("_at") && !k.startsWith("traffic_grid_fill_")).map(([k, v]) => <span key={k} className="mono text-fg-3" title={`${k} — 이 작업이 마지막으로 보고한 시각(collector heartbeat)${fmtTimeTitle(at(v)) ? ` · ${fmtTimeTitle(at(v))}` : ""}`}>{k.replace("_at", "")} {fmtKst(at(v))}</span>)}
            {prov.collector?.fixture === "1" ? <span className="badge warn">FIXTURE</span> : null}
          </div>
          {/* 연안 교통량 격자 위치 채우기 진행(ADR-023 2026-10-01 개정) — 수렴을 DB · 컨테이너 로그 없이 본다(수집기 heartbeat 그대로) */}
          <TrafficGridFill collector={prov.collector} nowMs={providersNowMs(prov)} />
          <div role="status" aria-live="polite">{switchMsg?.ok ? <div className="mb-2 text-[11px] text-ok" data-testid="switch-ok">{switchMsg.text}</div> : null}</div>
          {switchMsg && !switchMsg.ok ? <div className="mb-2 text-[11px] text-warn" role="alert" data-testid="switch-unmirrored">{switchMsg.text}</div> : null}
          {switchErr ? (
            <div className="mb-2 flex flex-wrap items-center gap-x-2 text-[11px] text-bad" role="alert" data-testid="switch-error">
              <ErrorNote prefix={`${switchErr.name} ${switchErr.action === "disable" ? "끄기" : "켜기"} 실패 — `} error={switchErr.error} />
              <button className={SMALL_BTN} onClick={() => setSwitchErr(null)}>알림 닫기</button>
            </div>
          ) : null}
          {differs.length ? (
            <div className="mb-2 text-[11px] text-warn" role="alert" data-testid="switch-mirror-differs">
              Redis 미러가 DB 원본과 다름 — 수집기는 Redis 값을 따른다: {differs.join(", ")} · api 가 60 s 주기로 원본을 다시 미러한다
            </div>
          ) : null}
          <div role="status" aria-live="polite">{resolveNote ? <div className="mb-2 text-[11px] text-ok" data-testid="resolve-ok">{resolveNote}</div> : null}</div>
          {(() => { const s = parseResolutionState(prov.resolution_state); return s && s !== "ok" ? <div className="mb-2 text-[11px] text-warn" data-testid="ops-resolution-state">{RESOLUTION_STATE_TEXT[s]}</div> : null; })()}
          <table><thead><tr><th>provider</th><th>last success (KST)</th><th>latency</th><th>records</th><th>fails</th><th title={BUDGET_USED_TITLE}>budget used / limit</th><th>remaining (hdr)</th><th title={LAST_ERROR_TITLE}>last error</th><th title="켜고 끄기 — 원본은 DB provider_switch, 수집기는 Redis 미러를 따른다">switch · DB → Redis</th></tr></thead>
            <tbody>{prov.providers.map((p) => { const sw = prov.provider_switch?.find((x) => x.provider === String(p.name)); const cell = switchCell(sw); const off = sw?.disabled ?? p.disabled === "1";
              const busy = busySwitch.has(String(p.name)); const miss = providerMissing(p, providersNowMs(prov)); return <Fragment key={String(p.name)}><tr>
              <td className="mono">{String(p.name)}{off ? <span className="badge bad ml-1" title={sw?.disabled != null ? "원본(DB) 기준" : "Redis 미러 기준(원본 행 없음)"}>disabled</span> : null}</td>
              <TimeCell v={p.last_success_at} /><td className={NUM_CELL}>{fmtLatencyMs(p.last_latency_ms)}</td><td className={NUM_CELL}>{String(p.last_records ?? "—")}</td>
              <td className={`${NUM_CELL} ${Number(p.consecutive_failures) > 0 ? "text-warn" : ""}`}>{String(p.consecutive_failures ?? "—")}</td>
              <td className={NUM_CELL} title="한도 — = 아직 보고되지 않음(성공한 수집이 없음) · ∞ = 한도 0(설정상 무제한)">{String(p.budget_used ?? "—")} / {fmtBudgetLimit(p.budget_limit)}</td><td className={NUM_CELL}>{String(p.budget_remaining ?? "—")}</td>
              <ProviderErrorCell p={p} onOpen={(target) => showResolve(String(p.name), target)} opener={resolveOpener(String(p.name))} />
              <td className="whitespace-nowrap" title={cell.title} data-testid="provider-switch"><span className="mono">{cell.source}</span> <span className={`badge ${cell.tone}`}>{cell.mirror}</span>{" "}
                {/* 같은 이름 단추가 공급자 수만큼 — 화면 읽기 단추 목록에서 구분되게 대상 이름을 붙인다(QA 2026-10 화면 개선 제안 3, 보이는 글자는 그대로) */}
                {off ? <button className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => toggle(String(p.name), "enable")}><span lang="en">enable</span><span className="sr-only">: {String(p.name)}</span></button>
                  : <button className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => toggle(String(p.name), "disable")}><span lang="en">disable</span><span className="sr-only">: {String(p.name)}</span></button>}</td>
            </tr>
            {/* 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30) — 호출은 성공해도 새 프레임이 오지 않는 까닭. 수집기는 그동안 last success 를 갱신하지 않는다 */}
            {miss ? <tr data-testid="provider-missing"><td colSpan={9} className="text-[11px] text-warn" title={miss.title}>
              <span aria-hidden="true">▲ </span>{miss.text} — 그동안 수집 실행은 &apos;missing&apos;(저장한 프레임 없음 — 목록에도 새 tm 이 없던 확인 포함), last success 는 프레임을 저장했거나 연속 밖에서 새 tm 이 없던(최신 tm 첫 저장 뒤 15분까지) 마지막 주기</td></tr> : null}
            {resolveOpen?.at === String(p.name) ? <tr><td colSpan={9}>
              <ResolveConfirm key={resolveOpen.n} id={resolvePanelId(resolveOpen.at)} target={resolveOpen.target} onClose={closeResolve} onChanged={(r) => resolveChanged(r, resolveOpen.n)} onAuthMiss={authMiss} />
            </td></tr> : null}</Fragment>; })}</tbody></table>
          <div className="label mt-4 mb-1" title="수집기가 스스로 한 공급자 전환(wakeline:events) — 위 표의 수동 켜고 끄기와 다르다">Provider switches (collector 자동 전환)</div>
          {/* 읽지 못한 기록을 '전환 없음' 과 가른다(리뷰 cto-2026-10 A4 — api 가 빈 switches 와 함께 error 를 싣는다) */}
          {(() => { const w = switchHistoryError(prov); return w ? <div className="mb-1 text-[11px] text-warn" role="alert" data-testid="switch-history-error">{w}</div> : null; })()}
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
          {drillGone ? <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-2" role="status" data-testid="runs-drill-gone">
            <span>{drillGoneText(drillGone.k, drillGone.mode)}</span>
            <button className={SMALL_BTN} onClick={() => setDrillGone(null)}>알림 닫기</button>
          </div> : null}
          <table className="mb-4"><thead><tr><th>job</th><th>provider</th><th>status</th><th>n</th><th>avg latency</th><th>last (KST)</th><th title={SUMMARY_LAST_ERROR_TITLE}>last error (raw)</th><th title={SUMMARY_OPEN_TITLE}>runs</th></tr></thead>
            <tbody>{runs.summary_24h.map((s, i) => {
              const key = runKeyOf(s);
              const kid = key ? runKeyId(key) : null;
              const open = drill != null && kid != null && runKeyId(drill.k) === kid;
              const le = summaryLastError(s);
              const label = `${String(s.job)} · ${String(s.provider)} · ${String(s.status)}`;
              return <Fragment key={kid ?? `row-${i}`}>
                <tr data-testid="runs-summary-row"><td>{String(s.job)}</td><td>{String(s.provider)}</td><td className={runStatusClass(s.status, "summary")} title={RUN_STATUS_TITLE[String(s.status)]}>{String(s.status)}</td><td className="mono">{String(s.n)}</td><td className={NUM_CELL}>{fmtLatencyMs(s.avg_latency_ms)}</td><TimeCell v={s.last_at} />
                  <td className="max-w-[420px]">{runStatusTone(s.status) === "ok" ? null
                    : !le.known ? <span className="text-fg-3" data-testid="runs-last-error-unknown" title="응답에 마지막 오류 글자(last_error_text)가 없음 — api 가 이 화면보다 옛 판일 수 있음. 행을 열면 실행마다 글자를 본다">—</span>
                    : le.text == null && le.http == null ? <span className="text-fg-3" title="가장 최근 실행에 오류 글자 · http 가 없음">—</span>
                    : <div className="flex items-start gap-1.5">
                        {le.http != null ? <span className="mono whitespace-nowrap text-[10px] text-fg-3" data-testid="runs-last-http">http {le.http}</span> : null}
                        {le.text != null ? <pre className="mono whitespace-pre-wrap text-[10px] text-fg-2" title={RAW_RECORD_TITLE} data-raw="record" data-testid="runs-last-error">{le.text}</pre> : null}
                      </div>}</td>
                  <td><button className={SMALL_BTN} disabled={!key} aria-expanded={open} aria-controls={open ? RUNS_DRILL_ID : undefined} data-testid="runs-drill-open"
                    aria-label={`${open ? "실행 목록 닫기" : "실행 목록 열기"}: ${label}`} title={SUMMARY_OPEN_TITLE}
                    onClick={() => { drillOpener.current = document.activeElement as HTMLElement | null; if (key) setDrill(open ? null : { k: key, since: summarySince(runs) }); }}>{open ? "접기" : "실행"}</button></td>
                </tr>
                {open && drill ? <tr><td colSpan={8}>
                  <OpsRunsDrill id={RUNS_DRILL_ID} k={drill.k} since={drill.since} onClose={() => { setDrill(null); rescue(() => [drillOpener.current, tabBody.current]); }} onAuthMiss={(e) => { void authMiss(e); }} />
                </td></tr> : null}
              </Fragment>;
            })}</tbody></table>
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
        {tab === "settings" && settings ? <SettingsForm items={settings.items} msg={settingsMsg} setMsg={setSettingsMsg} onSaved={refresh} onAuthMiss={fail} /> : null}
        {tab === "audit" && audit ? <>
          {/* 몇 건을 보이는지 · 앞선 기록이 더 있는지(QA-307 — 전에는 첫 50건에서 말없이 잘렸다) */}
          <div className="mb-1 text-[11px] text-fg-2" data-testid="audit-count">
            최신순 <span className="mono">{auditPages.rows.length.toLocaleString("en-US")}</span>건 — {auditPages.next != null ? "앞선 기록이 남음(아래 단추로 이어 받음)" : "처음 기록까지 모두"}
          </div>
          {auditPages.reset ? <div className="mb-1 text-[11px] text-warn" role="status" data-testid="audit-reset">
            앞서 이어 받은 기록은 접었다 — 그 사이 새 기록이 한 쪽({AUDIT_PAGE_LIMIT}건) 넘게 쌓여 사이를 이어 붙일 수 없음. 최신 {AUDIT_PAGE_LIMIT}건부터 다시 보인다
          </div> : null}
          <table><thead><tr><th>at (KST)</th><th>user</th><th>action</th><th>target</th><th title={AUDIT_RAW_TITLE}>before (raw)</th><th title={AUDIT_RAW_TITLE}>after (raw)</th><th>ip</th><th>request</th></tr></thead>
            <tbody>{auditPages.rows.map((a) => <tr key={String(a.id)}><TimeCell v={a.at} /><td>{String(a.username ?? "")}</td><td>{String(a.action)}</td><td className="mono">{String(a.target ?? "")}</td>
              <td className="mono text-fg-3" data-raw="record" title={a.before == null ? undefined : AUDIT_RAW_TITLE}>{String(a.before ?? "")}</td><td className="mono" data-raw="record" title={a.after == null ? undefined : AUDIT_RAW_TITLE}>{String(a.after ?? "")}</td>
              <td className="mono">{String(a.ip ?? "")}</td><td className="mono text-fg-3">{String(a.request_id ?? "")}</td></tr>)}</tbody></table>
          {auditPages.err ? <div className="mt-1 text-[11px] text-bad" role="alert" data-testid="audit-more-failed"><ErrorNote prefix="앞선 감사 기록을 불러오지 못함(보인 행은 그대로) — " error={auditPages.err} /></div> : null}
          {auditPages.next != null ? (
            <button ref={auditMore} className="btn mt-1 normal-case!" onClick={() => { rescue(() => [auditMore.current, tabBody.current]); void auditPages.more(); }}
              aria-disabled={auditPages.busy || undefined} aria-busy={auditPages.busy || undefined}
              title={`cursor ${auditPages.next} — 이 id 보다 앞선 기록 ${AUDIT_PAGE_LIMIT}건`} data-testid="audit-more">더 보기(이전 {AUDIT_PAGE_LIMIT}건)</button>
          ) : null}
        </> : null}
        {tab === "dlq" && dlq ? (() => {
          // 읽지 못한 목록을 '없음' 과 가른다 — api 가 빈 items 와 함께 error 를 싣는다(providers 탭의 자동 전환 기록과 같은 줄)
          const w = dlqReadError(dlq);
          return <>
            {w ? <div className="mb-1 text-[11px] text-warn" role="alert" data-testid="dlq-error">{w}</div> : null}
            {dlq.items.length ? <table><thead><tr><th>at (KST)</th><th>stream</th><th>kind</th><th>reason</th><th title={`스트림 메시지 앞 200자 — ${RAW_RECORD_TITLE}`}>payload head (raw)</th></tr></thead>
              <tbody>{dlq.items.map((d) => <tr key={String(d.stream_id)}><TimeCell v={d.at} /><td className="mono">{String(d.source_stream)}</td><td>{String(d.kind)}</td><td className="text-bad">{String(d.reason)}</td><td className="mono text-fg-3" data-raw="record">{String(d.payload_head)}</td></tr>)}</tbody></table>
              : w ? null : <div className="text-fg-3">스키마 검증에 실패한 메시지가 없습니다.</div>}
          </>;
        })() : null}
      </div>
    </div>
  );
}

/** 설정 저장의 결과 문구: 성공(ok, role=status)과 실패(bad, role=alert)를 색·역할로 구분한다(R-56). 서버 실패는 요청 id(복사 — 계약 v5 §C8)를 붙인다 */
type SettingsMsg = { ok: boolean; text: string; error?: unknown };

/** msg · setMsg = 결과 문구 — 대시보드가 갖는다(탭을 오가도 실패가 남게 — PLAN §5 결정 4) */
function SettingsForm({ items, msg, setMsg, onSaved, onAuthMiss }: {
  items: Settings["items"]; msg: SettingsMsg | null; setMsg: (m: SettingsMsg | null) => void; onSaved: () => void; onAuthMiss: (e: unknown) => void;
}) {
  // 편집 값과 편집을 시작할 때 본 version(R-35): 15 s 새로고침이 version 을 바꿔도 저장은 처음 본 version 으로 If-Match 한다
  const [edit, setEdit] = useState<Record<string, SettingEdit>>({});
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  /**
   * 응답을 기다리는 저장 — 키마다 한 번만. 같은 If-Match 로 PUT 이 두 번 나가면 첫 번째가 저장되고 두 번째가 409 라 저장됐는데 '다른 곳에서 바뀜' 을 보였다.
   * ref 는 같은 프레임의 두 번째 누름을, state 는 단추의 바쁨(disabled · aria-busy)을 맡는다
   */
  const saving = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 키마다 값 입력 — save 를 누르면 단추가 비활성이 되어(보내는 동안 · 저장 뒤 바뀐 값 없음) 초점이 body 로 떨어졌다(QA-304). 그때 그 키의 입력으로 옮긴다
   * (결과는 위 role=status · alert 문구가 읽힌다)
   */
  const inputs = useRef(new Map<string, HTMLElement>());
  const rescue = useFocusRescue();
  const drop = (k: string) => setEdit((e) => { const c = { ...e }; delete c[k]; return c; });
  const save = async (k: string) => {
    const ed = edit[k];
    if (ed === undefined || saving.current.has(k)) return;
    rescue(() => [inputs.current.get(k)]);
    // 서버 검증 규칙(SettingsService.validate)을 보내기 전에 — 규칙을 모르는 키는 서버가 검사
    const parsed = parseSetting(k, ed.value);
    if (!parsed.ok) { setFieldErr((f) => ({ ...f, [k]: parsed.error })); setMsg({ ok: false, text: `${k}: 저장하지 않음 — ${parsed.error}` }); return; }
    setFieldErr((f) => { const c = { ...f }; delete c[k]; return c; });
    saving.current.add(k);
    setBusy(new Set(saving.current));
    try { await saveSetting(k, parsed.value, settingIfMatch(ed)); setMsg({ ok: true, text: `${k} 저장됨 — 다음 주기부터 적용` }); drop(k); onSaved(); }
    catch (e) {
      if (isAuthMiss(e)) onAuthMiss(e);
      const conflict = e instanceof ApiError && e.status === 409;
      const text = conflict ? "편집하는 동안 다른 곳에서 바뀌었습니다 — 새 값을 확인한 뒤 다시 저장하세요"
        : e instanceof ApiError && e.status === 400 ? `서버가 값을 거절했습니다(${e.message})`
        : e instanceof ApiError ? `저장 실패(HTTP ${e.status})` : "서버에 연결할 수 없습니다(네트워크)";
      setMsg({ ok: false, text: `${k}: ${text}`, error: e });
      if (conflict) onSaved(); // 새 값·version 을 바로 받아 충돌 표시
    } finally {
      saving.current.delete(k);
      setBusy(new Set(saving.current));
    }
  };
  return (
    <div>
      <div className="mb-2 text-[11px] text-fg-3">변경은 If-Match(version) 낙관적 잠금 + CSRF 헤더로 보호되며 감사 로그에 남습니다. collector 는 다음 주기에 반영합니다. 편집하는 동안 서버 값이 바뀌면 행에 표시하고, 덮어쓰기는 직접 골라야 합니다.</div>
      <div className="mb-2 text-[11px] text-fg-3"><span className="mono">ais_bboxes</span>: 선박 수신 영역 <span className="mono">lat1,lon1,lat2,lon2</span>(여러 상자는 <span className="mono">;</span>) · 비우면 .env <span className="mono">AIS_BBOXES</span> · 전세계 <span className="mono">-90,-180,90,180</span> · ais 가 30 s 안에 같은 연결로 다시 구독합니다.</div>
      <div role="status" aria-live="polite">{msg?.ok ? <div className="mb-2 text-[11px] text-ok" data-testid="settings-ok">{msg.text}</div> : null}</div>
      {msg && !msg.ok ? <div className="mb-2 text-[11px] text-bad" role="alert" data-testid="settings-error">{msg.text}<RequestIdOf error={msg.error} />
        {/* 실패는 다음 저장이나 이 단추 전까지 남는다(PLAN §5 결정 4) — 15 s 새로고침도, 다른 탭에 다녀오는 것도 지우지 않는다(문구는 대시보드에) */}
        <button className={SMALL_BTN} onClick={() => setMsg(null)}>알림 닫기</button></div> : null}
      <table><thead><tr><th>key</th><th>value</th><th>version</th><th>updated (KST)</th><th></th></tr></thead>
        <tbody>{items.map((s) => {
          const ed = edit[s.key];
          const conflict = settingConflict(ed, s);
          return <tr key={s.key} data-testid="setting-row" data-conflict={conflict ? "true" : undefined}><td className="mono">{s.key}</td>
            <td>
              <SettingInput k={s.key} value={ed?.value ?? String(s.value)} error={fieldErr[s.key] ?? null} onChange={(v) => setEdit({ ...edit, [s.key]: editSetting(ed, s, v) })}
                inputRef={(el) => { if (el) inputs.current.set(s.key, el); else inputs.current.delete(s.key); }} />
              {conflict && ed ? (
                <div className="mt-1 text-[11px] text-warn" role="alert" data-testid="setting-conflict">
                  편집하는 동안 서버 값이 바뀜(v{ed.version} → v{s.version}: <span className="mono">{String(s.value)}</span>)
                  <button className="btn ml-1" onClick={() => drop(s.key)}>새 값 보기</button>
                  <button className="btn ml-1" onClick={() => setEdit({ ...edit, [s.key]: rebaseSetting(ed, s) })}>내 값으로 덮어쓰기</button>
                </div>
              ) : null}
            </td>
            <td className="mono">{s.version}</td><td className="text-fg-3"><span className="mono">{s.updated_by ?? "—"}</span> <KstTime v={s.updated_at} variant="cell" /></td>
            <td><button className="btn" onClick={() => save(s.key)} disabled={ed === undefined || conflict || busy.has(s.key)} aria-busy={busy.has(s.key) || undefined}
              title={conflict ? "서버 값이 바뀜 — 새 값 보기 또는 덮어쓰기를 먼저 고르세요" : undefined}><span lang="en">save</span><span className="sr-only">: {s.key}</span></button></td></tr>;
        })}</tbody></table>
    </div>
  );
}

/** 키별 입력(R-56): 정수 → number(min/max), 켜기/끄기 → checkbox, 형식이 정해진 문자열 → text + 형식 안내. 값은 문자열로 편집한다(R-35 편집 상태). */
function SettingInput({ k, value, error, onChange, inputRef }: { k: string; value: string; error: string | null; onChange: (v: string) => void; inputRef?: (el: HTMLInputElement | null) => void }) {
  const spec = settingSpec(k);
  const describedBy = error ? `setting-err-${k}` : spec && spec.kind !== "bool" ? `setting-hint-${k}` : undefined;
  const common = { "aria-label": `${k} 값`, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy, ref: inputRef };
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
