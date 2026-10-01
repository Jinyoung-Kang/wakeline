"use client";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { logItem, logsPage } from "@/lib/endpoints/logs";
import { opsSession, signOutRequest } from "@/lib/endpoints/ops";
import { copyText, downloadText } from "@/lib/copy";
import { fmtKstClock, fmtTimeTitle } from "@/lib/time";
import {
  DEFAULT_LOG_FILTER, entryKey, initialLogsState, firstLine, groupText, LOG_LEVELS, LOG_PERIOD_LABEL, LOG_PERIODS, LOG_Q_MAX, LOG_SCAN_MAX, LOG_SERVICES,
  LOG_STREAM_KEEP, LOG_STREAM_KEY, LOG_STREAM_NODE, logsFileName, logsNdjson, logsText, logText, LOGS_PAGE_MAX, parseLogsHash,
  validRid, withGroupResolutions, type LogEntry, type LogFilter, type LogGroup, type LogPage, type LogPeriod, type LogStreamName,
} from "@/lib/logs";
import { classifyOpsError, isAuthMiss, SESSION_EXPIRED_NOTE, signOut } from "@/lib/ops";
import { hiddenText, RESOLUTION_STATE_TEXT, type ResolutionState } from "@/lib/resolutions";
import { AisGapsTable } from "./AisGapsTable";
import { ErrorNote } from "./ErrorNote";
import { LogDetail } from "./LogDetail";
import { LogGroupsTable } from "./LogGroupsTable";
import { KstTime } from "../KstTime";
import { ResolveConfirm, useResolveSlot, type ResolveResult } from "../ResolveConfirm";
import { revokeLogGroup } from "./logGroupTargets";
import { useLogFeed, type LogView } from "./useLogFeed";
import { useFocusRescue } from "@/lib/use-focus-rescue";

type Tab = "logs" | "gaps";
type View = LogView;
const PERIODS = Object.keys(LOG_PERIODS) as LogPeriod[];
const LEVEL_BADGE: Record<string, string> = { ERROR: "badge bad", WARN: "badge warn" };
const n = (v: number) => v.toLocaleString("en-US");
/** 목록 줄의 DOM id — 표(grid)의 aria-activedescendant 가 가리킨다. 항목 키(stream:id — 같은 id 가 두 스트림에 있을 수 있다, §G2)에서 ':' 만 바꾼다 */
const rowDomId = (key: string) => `log-row-${key.replace(":", "-")}`;
const n0 = (v: number) => v.toLocaleString("en-US");
/** 두 스트림의 보관 안내(§G2) */
const KEEP_TEXT = `서버 로그 ${LOG_STREAM_KEY.server} 는 최근 약 ${n0(LOG_STREAM_KEEP.server)}건 · 브라우저 오류 ${LOG_STREAM_KEY.client} 는 최근 약 ${n0(LOG_STREAM_KEEP.client)}건만 보관`;
/** 묶음 목록이 바뀌었는지(지문 · 건수 · 마지막 항목 · 해결) */
/** "해결 처리로 숨김 N건"의 뜻(ADR-024) */
const HIDDEN_TITLE = "해결 처리(운영자가 지문 묶음을 'upto 까지 해결'로 적음)로 이 보기에서 뺀 항목 수 — 훑은 범위에서 다른 필터에 맞은 것만. "
  + "지우지 않음: '해결된 항목 보기'로 다시 보고, upto 뒤의 재발은 다시 보인다(ADR-024). — = api 가 수를 주지 않음";

/** 해결 표시 줄: 가림이면 "해결 처리로 숨김 N건"(여러 쪽이면 합계라고), 보임이면 그렇다고. 해결 기록 상태가 ok 가 아니면 경고 */
function HiddenLine({ show, hidden, pages, state }: { show: boolean; hidden: number | null; pages: number; state: ResolutionState | null }) {
  return <>
    <span data-testid="logs-hidden-resolved" className="text-fg-3" title={HIDDEN_TITLE}>
      {show ? "해결된 항목 포함(흐리게 표시)" : `해결 처리로 숨김 ${hiddenText(hidden)}${pages > 1 && hidden != null ? `(불러온 ${pages}쪽 합계)` : ""}`}
    </span>
    {state && state !== "ok" ? <span className="text-warn" data-testid="logs-resolution-state">{RESOLUTION_STATE_TEXT[state]}</span> : null}
  </>;
}

/** 첫 필터 · 열 항목 — 주소의 #rid= · #fp= · #id=(lib/logs initialLogsState) */
const initialState = () => initialLogsState(typeof window !== "undefined" ? window.location?.hash ?? "" : "");

/**
 * 시스템 로그 화면(계약 v5 §C7): 필터(서비스 여러 개 · 수준 · 기간 · 글자 · 요청 id) · 보기(목록 / 지문 묶음) · 상세 · 복사 · 내려받기 · AIS 수신 공백 탭.
 * - 15 s 마다 새 항목을 확인하지만 목록은 "새 항목 N건" 단추를 눌러야 바뀐다(보던 줄이 움직이지 않게).
 * - 서버가 말한 한계(스캔 상한 잘림 · 형식 오류로 건너뜀 · 다음 커서)를 그대로 보인다. 모르는 값은 "—".
 * - 시각은 KST 만(계약 v5 §G20 · lib/time — 표 칸 "(KST)", title 에 연도 · ms 까지의 KST). 텍스트 복사 · .txt 도 KST(+09:00), JSON 복사 · .ndjson 은 api 원본(ts 는 서버 형식 …Z).
 * - 메시지 칸은 서버가 기록한 글자 그대로(data-raw — 안의 시각을 바꾸지 않는다).
 * - 세션 만료(ops 호출 401/404 + 세션 확인도 401/404)면 로그인으로(R-12 와 같은 규칙).
 */
export function LogsDashboard({ me, onLeave }: { me: { username: string }; onLeave: (note: string | null) => void }) {
  const [init] = useState(initialState);
  const [tab, setTab] = useState<Tab>("logs");
  const [view, setView] = useState<View>("list");
  const [filter, setFilter] = useState<LogFilter>(init.filter);
  const [draftQ, setDraftQ] = useState(init.filter.q);
  const [draftRid, setDraftRid] = useState(init.filter.rid);
  const [ridError, setRidError] = useState<string | null>(null);
  /** 고른 줄의 항목 키(entryKey — stream:id) */
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [detailMiss, setDetailMiss] = useState<{ id: string; error: unknown } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** 목록 줄의 되돌리기 확인(해결된 항목이 보일 때 — 그 줄 아래, 한 번에 하나) */
  const rowResolve = useResolveSlot();
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());
  /** 목록을 새로 받으면 고른 줄은 그 목록에 있을 때만 남는다 */
  const keepSelection = useCallback((p: LogPage) => setSelId((s) => (s && p.items.some((e) => entryKey(e) === s) ? s : null)), []);
  /** 목록 · 묶음 · 새 항목 대기열 · 더 보기 · 15 s 자동 확인 · 마지막 성공 시각 · 오류(./useLogFeed) */
  const { page, pending, groups, setGroups, freshGroups, loading, moreCursor, err, lastOk, fail, load, loadMore, showPending, showFreshGroups } =
    useLogFeed(view, filter, { active: tab === "logs", onLeave, onList: keepSelection });
  /** 상세의 조회 · 해결 쓰기가 401/404 일 때 — 세션 확인만(문구는 부른 쪽이 보인다). 만료면 로그인으로 */
  const authMiss = useCallback(async (e: unknown) => {
    const k = await classifyOpsError(e, () => opsSession());
    if (k === "expired") onLeave(SESSION_EXPIRED_NOTE);
    return k;
  }, [onLeave]);

  /**
   * 상세 열기 번호 — #id= 링크 · 줄 · 닫기마다 오른다. 먼저 누른 #id= 항목의 늦은 답이 나중에 연 상세를 덮지 않게(마지막 것만 — web-review B14,
   * 해결 뒤 다시 읽기의 rereadSeq 와 같은 규칙)
   */
  const openSeq = useRef(0);
  const openById = useCallback(async (id: string, stream: LogStreamName | null = null) => {
    const my = ++openSeq.current;
    setDetailMiss(null);
    try {
      const e = await logItem(id, stream);
      if (my !== openSeq.current) return;
      if (e) setDetail(e);
      else setDetailMiss({ id, error: new Error("항목 형식이 스키마와 맞지 않음") });
    } catch (e) {
      if (my !== openSeq.current) return;
      setDetailMiss({ id, error: e });
      if (isAuthMiss(e)) authMiss(e);
    }
  }, [authMiss]);
  // #id=…(&stream=…) 로 열었으면 그 항목(GET /api/v1/ops/logs/{id}?stream=…)
  useEffect(() => {
    if (!init.openId) return;
    const t = setTimeout(() => void openById(init.openId!, init.openStream), 0);
    return () => clearTimeout(t);
  }, [init.openId, init.openStream, openById]);
  // 같은 화면에서 #rid= · #fp= · #id= 링크를 눌렀을 때(오류 문구 · 상세의 요청 id 링크)
  useEffect(() => {
    const onHash = () => {
      const h = parseLogsHash(window.location?.hash ?? "");
      if (h.rid || h.fp) {
        setTab("logs"); setView("list");
        setFilter((f) => ({ ...f, ...(h.rid ? { rid: h.rid, period: "7d" as const } : {}), ...(h.fp ? { fp: h.fp } : {}) }));
        if (h.rid) { setDraftRid(h.rid); setRidError(null); }
      }
      if (h.id) void openById(h.id, h.stream ?? null);
    };
    window.addEventListener?.("hashchange", onHash);
    return () => window.removeEventListener?.("hashchange", onHash);
  }, [openById]);

  // 키보드로 고른 줄을 보이게
  useEffect(() => { if (selId) rowEls.current.get(selId)?.scrollIntoView?.({ block: "nearest" }); }, [selId]);

  const items = page?.items ?? [];
  const selIdx = items.findIndex((e) => entryKey(e) === selId);

  const copy = useCallback(async (label: string, text: string | (() => Promise<string>)) => {
    try {
      const t = typeof text === "string" ? text : await text();
      const ok = await copyText(t);
      setNote(ok ? { ok, text: `복사됨: ${label} (${n(t.length)}자)` } : { ok, text: `복사 실패: ${label} — 브라우저가 클립보드를 막음` });
    } catch (e) {
      setNote({ ok: false, text: `복사 실패: ${label}` });
      fail(e);
    }
  }, [fail]);
  const download = (ext: "txt" | "ndjson") => {
    const name = logsFileName(ext, Date.now());
    const ok = downloadText(name, ext === "txt" ? logsText(items) : logsNdjson(items), ext === "txt" ? "text/plain" : "application/x-ndjson");
    setNote(ok ? { ok, text: `내려받기: ${name} (${n(items.length)}건)` } : { ok, text: "내려받기 실패" });
  };
  /** 묶음 전체: 그 지문의 항목(기간·서비스·수준 같게, 최대 200건)을 받아 묶음 머리와 함께 */
  const copyGroup = (g: LogGroup) => copy(`묶음 ${g.fp}`, async () => {
    const p = await logsPage({ ...filter, q: "", rid: "", fp: g.fp }, Date.now(), { limit: LOGS_PAGE_MAX });
    const truncated = p.nextCursor != null || p.scanTruncated === true || (g.count != null && p.items.length < g.count);
    return groupText(g, p.items, { truncated });
  });
  /** 목록 표(grid)에 초점이 있을 때만 — 다른 요소(단추 · 입력)에서 올라온 키는 그 요소의 것이다 */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey || e.ctrlKey || e.metaKey || view !== "list" || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = selIdx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, selIdx + (e.key === "ArrowDown" ? 1 : -1)));
      setSelId(entryKey(items[i]));
    } else if (e.key === "Enter" && selIdx >= 0) {
      e.preventDefault();
      openEntry(items[selIdx]);
    } else if (e.key === "c" || e.key === "C") {
      const it = selIdx >= 0 ? items[selIdx] : detail;
      if (it) { e.preventDefault(); void copy("항목 텍스트", logText(it)); }
    }
  };
  const toggleService = (s: string) => setFilter((f) => {
    const next = new Set(f.services);
    if (next.has(s)) next.delete(s); else next.add(s);
    return { ...f, services: LOG_SERVICES.filter((x) => next.has(x)) };
  });
  const applyText = (e: React.FormEvent) => {
    e.preventDefault();
    const rid = draftRid.trim();
    if (rid && !validRid(rid)) { setRidError("요청 id 형식: 영문·숫자·- 8–64자 — 적용하지 않음"); return; }
    setRidError(null);
    setFilter((f) => ({ ...f, q: draftQ.trim().slice(0, LOG_Q_MAX), rid }));
  };
  const reset = () => { setFilter(DEFAULT_LOG_FILTER); setDraftQ(""); setDraftRid(""); setRidError(null); };
  /**
   * 누른 단추가 사라지는 조작(상세 '닫기' · '새 항목 N건' · 묶음의 '목록으로') 뒤 초점(WCAG 2.4.3 — QA-304): 초점이 body 로 떨어졌으면 목록 표(grid)로,
   * 목록을 받는 동안이면 목록 영역으로(lib/use-focus-rescue — 초점을 잃었을 때만)
   */
  const listRegion = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const rescue = useFocusRescue();
  const backToList = useCallback(() => rescue(() => [grid.current, listRegion.current]), [rescue]);
  const filterFp = useCallback((fp: string) => { setView("list"); setFilter((f) => ({ ...f, fp })); backToList(); }, [backToList]);
  /** 요청 id 로 거르기(상세 · 오류 문구) — 요청 시각을 모르므로 가장 긴 기간 */
  const filterRid = useCallback((rid: string) => {
    setTab("logs"); setView("list"); setDraftRid(rid); setRidError(null);
    setFilter((f) => ({ ...f, rid, period: "7d" }));
  }, []);
  const openEntry = useCallback((e: LogEntry) => { openSeq.current++; setDetail(e); setDetailMiss(null); }, []);
  const closeDetail = useCallback(() => { openSeq.current++; setDetail(null); setDetailMiss(null); backToList(); }, [backToList]);
  const logout = () => { void signOut(() => signOutRequest(), onLeave); };

  /** 열린 상세 — 해결 쓰기 뒤 다시 읽을 항목(콜백이 상세가 바뀔 때마다 새로 만들어지지 않게 ref) */
  const detailRef = useRef<LogEntry | null>(null);
  useEffect(() => { detailRef.current = detail; }, [detail]);
  /** 지금 보기 · 필터 — 쓰기 결과는 보낼 때가 아니라 받을 때 보이는 것을 다시 읽는다(보내는 동안 보기를 바꿨을 수 있다) */
  const shown = useRef({ view, filter });
  useEffect(() => { shown.current = { view, filter }; }, [view, filter]);
  /** 항목 다시 읽기 번호 — 먼저 떠난 느린 응답이 나중 쓰기 뒤에 읽은 값을 덮지 않게(마지막 요청의 응답만 반영) */
  const rereadSeq = useRef(0);
  /**
   * 해결 쓰기 뒤(201/204 — ResolveConfirm): 201 은 받은 해결을 바로 붙이고(낙관적 표시는 201 뒤에만: 묶음 · 열린 상세가 그 지문의 upto 이하일 때),
   * 204 는 붙이지 않는다(같은 지문의 앞선 해결이 아직 덮을 수 있다 — 서버가 정한다). 둘 다 지금 보기(목록 · 묶음)와 열린 상세를 다시 읽는다.
   */
  const resolveChanged = useCallback((r: ResolveResult) => {
    const open = detailRef.current;
    if (r.op === "resolve") {
      setGroups((g) => (g ? withGroupResolutions(g, r.created) : g));
      const cover = open?.fp ? r.created.find((c) => c.key === open.fp && Date.parse(c.upto) >= Date.parse(open.ts)) : undefined;
      if (open && cover) setDetail((d) => (d && entryKey(d) === entryKey(open) ? { ...d, resolved: { id: cover.id, upto: cover.upto, resolved_by: cover.resolved_by } } : d));
      const what = r.created.length === 1 ? `묶음 ${r.created[0].key}(해결 #${r.created[0].id})` : `묶음 ${r.saved}개`;
      setNote({ ok: true, text: `해결 처리됨: ${what} — 목록을 다시 불러옴(가린 항목은 '해결된 항목 보기'로)` });
    } else if (r.complete) {
      setNote({ ok: true, text: `되돌림: 해결 #${r.id} — 목록을 다시 불러옴` });
    }
    void load(shown.current.view, shown.current.filter);
    if (open) {
      const my = ++rereadSeq.current;
      void logItem(open.id, open.stream).then((x) => {
        if (my !== rereadSeq.current) return;
        if (x) setDetail((d) => (d && entryKey(d) === entryKey(open) ? x : d));
      }, () => {
        if (my !== rereadSeq.current) return;
        // 항목을 다시 읽지 못함(스트림에서 잘림 등) — 해결 표시는 받은 결과까지만 믿는다
        if (r.op === "revoke" && r.complete) setDetail((d) => (d && entryKey(d) === entryKey(open) ? { ...d, resolved: null } : d));
      });
    }
  }, [load, setGroups]);

  return (
    <div className="flex h-full flex-col" data-testid="logs-dashboard">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-3 py-1">
        <span className="label mr-2">System logs</span>
        <div className="flex gap-1" role="group" aria-label="로그 탭">
          <button type="button" className="btn" aria-pressed={tab === "logs"} onClick={() => setTab("logs")} data-session-focus={tab === "logs" || undefined}>로그</button>
          <button type="button" className="btn" aria-pressed={tab === "gaps"} onClick={() => setTab("gaps")} data-session-focus={tab === "gaps" || undefined}>AIS 수신 공백</button>
        </div>
        {tab === "logs" ? <>
          <button type="button" className="btn" onClick={() => void load(view, filter)} disabled={loading}>새로고침</button>
          <span className="mono text-[11px] text-fg-3" title={`마지막 성공 응답 시각(KST) — 15 s 마다 새 항목을 확인(목록은 단추를 눌러야 바뀜)${lastOk ? ` · ${fmtTimeTitle(lastOk)}` : ""}`} data-testid="logs-last-ok">갱신 {fmtKstClock(lastOk)} · 15 s 확인</span>
        </> : null}
        {err && tab === "logs" ? <span className="text-[11px] text-bad" role="alert"><ErrorNote error={err} onFilterRid={filterRid} /></span> : null}
        <span className="ml-auto text-[11px] text-fg-3">{me.username}</span>
        <Link className="btn" href="/ops">운영</Link>
        <button type="button" className="btn" onClick={logout}>sign out</button>
      </div>
      {tab === "gaps" ? <AisGapsTable initialPeriod={filter.period} onFilterRid={filterRid} /> : <>
        <form className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg-1 px-3 py-1.5 text-[11px]" onSubmit={applyText} data-testid="logs-filter-form">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="서비스(여러 개 — 선택 없음 = 전체)">
            <span className="label mr-1">서비스</span>
            {LOG_SERVICES.map((s) => <button key={s} type="button" className="btn normal-case!" aria-pressed={filter.services.includes(s)} onClick={() => toggleService(s)}>{s}</button>)}
            <span className="mono text-fg-3">{filter.services.length ? `${filter.services.length}/${LOG_SERVICES.length}` : "전체"}</span>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="수준">
            <span className="label mr-1">수준</span>
            <button type="button" className="btn" aria-pressed={filter.level === ""} onClick={() => setFilter((f) => ({ ...f, level: "" }))}>전체</button>
            {LOG_LEVELS.map((l) => <button key={l} type="button" className="btn" aria-pressed={filter.level === l} onClick={() => setFilter((f) => ({ ...f, level: l }))}>{l}</button>)}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="기간">
            <span className="label mr-1">기간</span>
            {PERIODS.map((p) => <button key={p} type="button" className="btn normal-case!" aria-pressed={filter.period === p} onClick={() => setFilter((f) => ({ ...f, period: p }))}>{LOG_PERIOD_LABEL[p]}</button>)}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="해결 표시">
            <span className="label mr-1">해결</span>
            <button type="button" className="btn normal-case!" aria-pressed={filter.resolved === "show"} data-testid="logs-show-resolved"
              title="해결 처리한 지문의 upto 이하 항목 — 끄면(기본) 목록 · 묶음에서 빼고 수만 보인다, 켜면 흐리게 함께(해결됨 · 처리한 사람 · upto)"
              onClick={() => setFilter((f) => ({ ...f, resolved: f.resolved === "show" ? "hide" : "show" }))}>해결된 항목 보기</button>
          </div>
          <label className="flex items-center gap-1"><span className="label">검색</span>
            <input aria-label="글자 검색" className="mono w-44" maxLength={LOG_Q_MAX} value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder="Enter 로 적용" />
          </label>
          <label className="flex items-center gap-1"><span className="label">요청 id</span>
            <input aria-label="요청 id" className="mono w-44" maxLength={64} value={draftRid} onChange={(e) => setDraftRid(e.target.value)} aria-invalid={ridError ? true : undefined}
              aria-describedby={ridError ? "logs-rid-error" : undefined} placeholder="X-Request-Id" />
          </label>
          <button type="submit" className="btn">적용</button>
          <button type="button" className="btn" onClick={reset}>초기화</button>
          {filter.fp ? (
            <span className="flex items-center gap-1 border border-accent px-1.5 py-0.5">
              <span className="label">지문</span><span className="mono">{filter.fp}</span>
              <button type="button" className="btn px-1! py-0!" aria-label="지문 필터 해제" onClick={() => setFilter((f) => ({ ...f, fp: "" }))}>×</button>
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="보기">
            <span className="label mr-1">보기</span>
            <button type="button" className="btn" aria-pressed={view === "list"} onClick={() => setView("list")}>목록</button>
            <button type="button" className="btn normal-case!" aria-pressed={view === "groups"} onClick={() => setView("groups")}>묶음(fp)</button>
          </div>
          {ridError ? <span id="logs-rid-error" className="w-full text-bad" role="alert" data-testid="logs-rid-error">{ridError}</span> : null}
        </form>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-[11px]" data-testid="logs-status">
          {view === "list" ? <>
            <span>{page ? `${n(items.length)}건 표시(최신 순)` : loading ? "불러오는 중…" : "—"}</span>
            {page?.scanned != null ? <span className="text-fg-3" title={`마지막 요청이 훑은 스트림 항목 수 — 두 스트림(${LOG_STREAM_KEY.server} · ${LOG_STREAM_KEY.client})을 합쳐 요청당 상한 ${n(LOG_SCAN_MAX)}(스트림마다 보관 수 + 근사 트림 여유 ${n(LOG_STREAM_NODE)}건)`}>훑은 항목 <span className="mono">{n(page.scanned)}</span></span> : null}
            {page?.scanTruncated ? <span className="text-warn">스캔 상한({n(LOG_SCAN_MAX)}건 — 두 스트림 합)에서 잘림 — 조건에 맞는 더 오래된 항목이 있을 수 있음</span> : null}
            {page ? <HiddenLine show={filter.resolved === "show"} hidden={page.hiddenResolved} pages={page.pages} state={page.resolutionState} /> : null}
            {page && (page.invalid > 0 || (page.serverInvalid ?? 0) > 0) ? (
              <span className="text-warn" data-testid="logs-skipped" title="api = 서버가 읽을 때 스키마 검증에 실패해 건너뛴 항목 · 화면 = 이 화면이 형식 오류로 버린 항목 — 둘 다 불러온 쪽들의 합(— = api 가 값을 주지 않음)">
                형식 오류로 건너뜀({page.pages > 1 ? `불러온 ${page.pages}쪽 합계` : "불러온 1쪽"}): api {page.serverInvalid ?? "—"} · 화면 {page.invalid}
              </span>
            ) : null}
            {pending.items.length ? (
              <button type="button" className="btn border-accent! text-accent!" data-testid="logs-new" onClick={() => { showPending(); backToList(); }}>
                {pending.more ? `새 항목 ${n(pending.items.length)}건 이상 — 다시 불러오기` : `새 항목 ${n(pending.items.length)}건`}
              </button>
            ) : null}
            <span className="ml-auto flex gap-1">
              <button type="button" className="btn" onClick={() => void copy(`보이는 목록 ${n(items.length)}건`, logsText(items))} disabled={!items.length} title="보이는 목록 — 텍스트(머리 줄 시각은 KST, ISO 8601 +09:00)">보이는 목록 복사</button>
              <button type="button" className="btn normal-case!" onClick={() => download("txt")} disabled={!items.length} title="보이는 목록 — 텍스트(머리 줄 시각은 KST, ISO 8601 +09:00)">.txt</button>
              <button type="button" className="btn normal-case!" onClick={() => download("ndjson")} disabled={!items.length} title="보이는 목록 — 한 줄에 항목 하나(JSON, api 가 준 그대로 — ts 는 서버 형식 ‘…Z’(KST 보다 9시간 이르다), 화면의 KST 로 바꾸지 않음)">.ndjson</button>
            </span>
          </> : <>
            <span>{groups ? `묶음 ${n(groups.groups.length)}개(최근 ${LOG_PERIOD_LABEL[filter.period]})` : loading ? "불러오는 중…" : "—"}</span>
            {groups?.scanned != null ? <span className="text-fg-3">훑은 항목 <span className="mono">{n(groups.scanned)}</span></span> : null}
            {groups?.scanTruncated ? <span className="text-warn">스캔 상한({n(LOG_SCAN_MAX)}건 — 두 스트림 합)에서 잘림 — 묶음·건수가 기간의 일부만</span> : null}
            {groups?.invalid ? <span className="text-warn">형식 오류 묶음 {groups.invalid}개 건너뜀</span> : null}
            {groups ? <HiddenLine show={filter.resolved === "show"} hidden={groups.hiddenResolved} pages={1} state={groups.resolutionState} /> : null}
            {freshGroups ? <button type="button" className="btn border-accent! text-accent!" data-testid="logs-new" onClick={() => { showFreshGroups(); backToList(); }}>묶음에 새 항목 — 반영</button> : null}
            <span className="text-fg-3">묶음 보기는 서비스·수준·기간만 적용(글자 검색·요청 id·지문 제외)</span>
          </>}
          <span role="status" aria-live="polite" data-testid="logs-note" className={note?.ok === false ? "text-bad" : "text-ok"}>{note?.text ?? ""}</span>
        </div>
        <div className="shrink-0 border-b border-line px-3 py-1 text-[10px] text-fg-3">
          수집: api · collector · ais 의 WARN·ERROR(비밀값 가림) + 브라우저 오류(web-client — 브라우저가 보낸 내용, 검증 안 됨, 따로 보관) · {KEEP_TEXT} · 목록은 두 스트림을 시각(스트림 id) 순으로 합침 ·
          시각 = 한국 표준시(KST — 마우스를 올리면 연도 · ms 까지) · 메시지는 서버가 기록한 글자 그대로 · JSON 복사 · .ndjson 의 ts 는 서버 형식(…Z) ·
          edge(nginx) 로그는 컨테이너 표준 출력에만(수집 에이전트 없음) · 키보드(목록): ↑/↓ 이동 · Enter 상세 · c 텍스트 복사
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div ref={listRegion} tabIndex={-1} className="min-h-0 flex-1 overflow-auto" role="region" aria-label="로그 목록" data-testid="log-list">
            {view === "list" ? <>
              {items.length ? (
                // 키보드: 표(grid)에 초점을 두고 고른 줄은 aria-activedescendant 로 알린다(화면 읽기 프로그램이 그 줄을 읽는다)
                <table ref={grid} role="grid" aria-readonly="true" tabIndex={0} onKeyDown={onKey} aria-label="로그 목록 — ↑/↓ 이동 · Enter 상세 · c 텍스트 복사"
                  aria-activedescendant={selIdx >= 0 ? rowDomId(entryKey(items[selIdx])) : undefined} data-testid="log-grid">
                  <thead className="sticky top-0 bg-bg-1"><tr>
                    <th scope="col" title="한국 표준시(KST) — 칸에 마우스를 올리면 연도 · ms 까지">시각(KST)</th><th scope="col">수준</th><th scope="col">서비스</th><th scope="col">로거</th><th scope="col">메시지(첫 줄)</th>
                    <th scope="col" title="직전 전송 뒤 같은 지문으로 보내지 않은 건수 — — = 필드 없음">억제</th><th scope="col">요청 id</th>
                  </tr></thead>
                  <tbody>{items.map((e) => {
                    const k = entryKey(e);
                    const res = e.resolved;
                    const panel = rowResolve.open?.at === k ? rowResolve.open : null;
                    return (
                    <Fragment key={k}>
                    <tr id={rowDomId(k)} data-testid="log-row" data-id={e.id} data-stream={e.stream ?? undefined} aria-selected={k === selId}
                      data-resolved={e.resolved ? "true" : undefined}
                      ref={(el) => { if (el) rowEls.current.set(k, el); else rowEls.current.delete(k); }}
                      onClick={() => { setSelId(k); openEntry(e); }}
                      className={`cursor-pointer ${e.resolved ? "text-fg-3" : ""} ${k === selId ? "bg-[#1c2a3f]" : "hover:bg-bg-2"} ${detail && entryKey(detail) === k ? "outline outline-1 -outline-offset-1 outline-accent" : ""}`}>
                      <td className="whitespace-nowrap"><KstTime v={e.ts} variant="cell" ms /></td>
                      <td><span className={LEVEL_BADGE[e.level]}>{e.level}</span></td>
                      <td className="mono whitespace-nowrap">{e.service}{e.untrusted ? <span className="badge ml-1 normal-case!" title="브라우저가 보낸 내용 — 검증 안 됨">untrusted</span> : null}
                        {e.stream === "client" ? <span className="badge ml-1 normal-case!" title={`${LOG_STREAM_KEY.client} — 브라우저 오류 스트림(따로 보관 · 최근 약 ${n(LOG_STREAM_KEEP.client)}건)`}>client</span> : null}</td>
                      <td className="mono max-w-[240px] truncate text-fg-2" title={e.logger ?? ""}>{e.logger ?? "—"}</td>
                      <td className="max-w-[560px] truncate"><span title={firstLine(e.message)} data-raw="log">{firstLine(e.message)}</span>
                        {res ? (
                          <div className="text-[10px]">
                            <span data-testid="log-resolved-mark" title={`해결 #${res.id} — 지문 묶음 단위(같은 지문의 upto 이하 항목)`}>해결됨 · <span className="mono">{res.resolved_by}</span> · <KstTime v={res.upto} /></span>
                            {/* 줄의 클릭(상세 열기)으로 올라가지 않는다 — 확인은 이 줄 아래 */}
                            <button type="button" className="btn ml-1 px-1.5! py-0! normal-case!" {...rowResolve.openerProps(k)} aria-label={`되돌리기: 지문 ${e.fp ?? "—"} 해결 #${res.id}`}
                              onClick={(ev) => { ev.stopPropagation(); rowResolve.show(k, revokeLogGroup(res, e.fp)); }}>되돌리기</button>
                          </div>
                        ) : null}</td>
                      <td className="mono text-right">{e.suppressed ?? "—"}</td>
                      <td className="mono whitespace-nowrap text-fg-3">{e.request_id ?? "—"}</td>
                    </tr>
                    {panel ? <tr><td colSpan={7}>
                      <ResolveConfirm key={panel.n} id={rowResolve.panelId(k)} target={panel.target} onClose={rowResolve.close} onAuthMiss={authMiss} onFilterRid={filterRid}
                        onChanged={(r) => { if (r.complete) rowResolve.closeIf(panel.n); resolveChanged(r); }} />
                    </td></tr> : null}
                    </Fragment>
                    );
                  })}</tbody>
                </table>
              ) : page ? (
                <div className="p-3 text-fg-3" data-testid="logs-empty">
                  조건에 맞는 항목 없음(최근 {LOG_PERIOD_LABEL[filter.period]}){page.scanTruncated ? " — 스캔 상한에서 잘려 더 오래된 항목은 확인하지 못함" : ""}
                  {filter.resolved === "hide" && page.hiddenResolved ? ` — 해결 처리로 숨긴 항목 ${hiddenText(page.hiddenResolved)}('해결된 항목 보기'로 다시 봄)` : ""}
                </div>
              ) : null}
              {page?.nextCursor ? (
                <button type="button" className="btn m-2" onClick={() => void loadMore()} title={`cursor ${page.nextCursor}`}
                  disabled={moreCursor === page.nextCursor} aria-busy={moreCursor === page.nextCursor || undefined}>이전 항목 더 보기</button>
              ) : page && items.length ? <div className="p-2 text-[11px] text-fg-3">끝 — 다음 커서 없음</div> : null}
            </> : groups ? (
              groups.groups.length ? (
                <LogGroupsTable groups={groups.groups} onFilterFp={filterFp} onCopyGroup={(g) => void copyGroup(g)} onChanged={resolveChanged} onAuthMiss={authMiss} onFilterRid={filterRid} />
              ) : <div className="p-3 text-fg-3" data-testid="logs-empty">조건에 맞는 묶음 없음(최근 {LOG_PERIOD_LABEL[filter.period]}){filter.resolved === "hide" && groups.hiddenResolved ? ` — 해결 처리로 숨긴 항목 ${hiddenText(groups.hiddenResolved)}('해결된 항목 보기'로 다시 봄)` : ""}</div>
            ) : null}
          </div>
          {/* 상세는 목록의 항목 — 묶음 보기에서는 접어 둔다(상태는 남는다) */}
          {view === "list" && (detail || detailMiss) ? (
            <aside className="max-h-[50%] min-h-0 overflow-auto border-t border-line bg-bg-1 lg:max-h-none lg:w-[46%] lg:border-t-0 lg:border-l" aria-label="항목 상세">
              {detail ? (
                <LogDetail key={entryKey(detail)} entry={detail} period={filter.period} resolvedMode={filter.resolved} onClose={closeDetail} onOpen={openEntry} onFilterFp={filterFp}
                  onFilterRid={filterRid} onCopy={(l, t) => void copy(l, t)} onAuthMiss={authMiss} onResolveChanged={resolveChanged} />
              ) : detailMiss ? (
                <div className="p-3 text-[12px]" data-testid="log-detail-miss">
                  <div className="mb-1"><span className="label mr-2">항목</span><span className="mono">{detailMiss.id}</span></div>
                  <div className="text-bad">
                    항목을 열지 못함 — 스트림에서 잘렸거나({KEEP_TEXT}) id 가 틀림 · <ErrorNote error={detailMiss.error} onFilterRid={filterRid} />
                  </div>
                  <button type="button" className="btn mt-2" onClick={closeDetail}>닫기</button>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </>}
    </div>
  );
}
