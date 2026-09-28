"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { copyText, downloadText } from "@/lib/copy";
import { fmtClock, fmtTime } from "@/lib/format";
import {
  appendLogPage, applyPending, DEFAULT_LOG_FILTER, firstLine, fmtLogTime, groupText, LOG_LEVELS, LOG_PERIOD_LABEL, LOG_PERIODS, LOG_Q_MAX, LOG_SERVICES, logGroupsUrl,
  logItemUrl, logsFileName, logsNdjson, logsText, logsUrl, logText, LOGS_PAGE, LOGS_PAGE_MAX, parseLogEntry, parseLogGroups, parseLogPage, parseLogsHash,
  pendingEntries, validRid, type LogEntry, type LogFilter, type LogGroup, type LogPage, type LogPeriod,
} from "@/lib/logs";
import { classifyOpsError, isAuthMiss, OPS_SESSION_PATH, SESSION_EXPIRED_NOTE, signOut } from "@/lib/ops";
import { AisGapsTable } from "./AisGapsTable";
import { ErrorNote } from "./ErrorNote";
import { LogDetail } from "./LogDetail";

type Tab = "logs" | "gaps";
type View = "list" | "groups";
type Groups = ReturnType<typeof parseLogGroups>;
/** 자동 새로 고침(§C7) — 새 항목은 단추로만 반영한다 */
const REFRESH_MS = 15_000;
const PERIODS = Object.keys(LOG_PERIODS) as LogPeriod[];
const LEVEL_BADGE: Record<string, string> = { ERROR: "badge bad", WARN: "badge warn" };
const NO_PENDING = { items: [] as LogEntry[], more: false };
const n = (v: number) => v.toLocaleString("en-US");
/** 목록 줄의 DOM id — 표(grid)의 aria-activedescendant 가 가리킨다(스트림 id 는 숫자와 - 뿐) */
const rowDomId = (id: string) => `log-row-${id}`;
/** 묶음 목록이 바뀌었는지(지문 · 건수 · 마지막 항목) */
const groupsSig = (g: Groups | null) => (g ? g.groups.map((x) => `${x.fp}:${x.count}:${x.last_id}`).join("|") : "");

/** 첫 필터: /logs#rid=… 는 시각을 모르므로 가장 긴 기간(7 d)으로, #fp=… 는 그 묶음만. #id=… 는 그 항목의 상세를 연다 */
function initialState(): { filter: LogFilter; openId: string | null } {
  const h = parseLogsHash(typeof window !== "undefined" ? window.location?.hash ?? "" : "");
  const filter: LogFilter = { ...DEFAULT_LOG_FILTER, ...(h.rid ? { rid: h.rid, period: "7d" as const } : {}), ...(h.fp ? { fp: h.fp } : {}) };
  return { filter, openId: h.id ?? null };
}

/**
 * 시스템 로그 화면(계약 v5 §C7): 필터(서비스 여러 개 · 수준 · 기간 · 글자 · 요청 id) · 보기(목록 / 지문 묶음) · 상세 · 복사 · 내려받기 · AIS 수신 공백 탭.
 * - 15 s 마다 새 항목을 확인하지만 목록은 "새 항목 N건" 단추를 눌러야 바뀐다(보던 줄이 움직이지 않게).
 * - 서버가 말한 한계(스캔 상한 잘림 · 형식 오류로 건너뜀 · 다음 커서)를 그대로 보인다. 모르는 값은 "—".
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
  /** at = 이 목록을 요청한 시각(기간의 기준 — "더 보기"도 같은 기준) */
  const [page, setPage] = useState<(LogPage & { at: number }) | null>(null);
  const [pending, setPending] = useState(NO_PENDING);
  const [groups, setGroups] = useState<Groups | null>(null);
  const [freshGroups, setFreshGroups] = useState<Groups | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [detailMiss, setDetailMiss] = useState<{ id: string; error: unknown } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** 목록·묶음을 새로 불러올 때마다 올린다 — 늦게 온 이전 필터의 응답(또는 그 사이의 자동 확인)을 버린다 */
  const loadSeq = useRef(0);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());

  /** ops 호출 실패: 문구로 보이고, 401/404 면 세션을 확인해 만료일 때만 로그인으로 */
  const fail = useCallback((e: unknown) => {
    setErr(e);
    if (!isAuthMiss(e)) return;
    void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
  }, [onLeave]);
  /** 상세의 조회가 401/404 일 때 — 세션 확인만(문구는 상세가 보인다) */
  const authMiss = useCallback((e: unknown) => {
    void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
  }, [onLeave]);

  const load = useCallback(async (v: View, f: LogFilter) => {
    const my = ++loadSeq.current;
    const at = Date.now();
    setLoading(true);
    try {
      if (v === "list") {
        const p = parseLogPage(await apiGet<unknown>(logsUrl(f, at)));
        if (my !== loadSeq.current) return;
        setPage({ ...p, at });
        setPending(NO_PENDING);
        setSelId((s) => (s && p.items.some((e) => e.id === s) ? s : null));
      } else {
        const g = parseLogGroups(await apiGet<unknown>(logGroupsUrl(f, at)));
        if (my !== loadSeq.current) return;
        setGroups(g);
        setFreshGroups(null);
      }
      setErr(null);
      setLastOk(Date.now());
    } catch (e) {
      if (my === loadSeq.current) fail(e);
    } finally {
      if (my === loadSeq.current) setLoading(false);
    }
  }, [fail]);

  // 필터·보기가 바뀌면 다시 불러온다(첫 요청은 다음 틱 — 개발 모드 이중 실행에서 한 번만)
  useEffect(() => {
    if (tab !== "logs") return;
    const t = setTimeout(() => void load(view, filter), 0);
    return () => clearTimeout(t);
  }, [tab, view, filter, load]);

  /** 자동 확인: 첫 쪽을 다시 받아 보이는 맨 위보다 새 항목만 대기열에(목록은 그대로). 묶음 보기는 바뀌었는지만 */
  const poll = useCallback(async () => {
    const my = loadSeq.current;
    try {
      if (view === "list") {
        const p = parseLogPage(await apiGet<unknown>(logsUrl(filter, Date.now())));
        if (my !== loadSeq.current) return;
        if (!page?.items.length) {
          // 보이는 줄이 없으면 움직일 것도 없다 — 바로 보인다
          setPage({ ...p, at: Date.now() });
          setPending(NO_PENDING);
        } else {
          setPending(pendingEntries(page.items, p.items, LOGS_PAGE));
        }
      } else {
        const g = parseLogGroups(await apiGet<unknown>(logGroupsUrl(filter, Date.now())));
        if (my !== loadSeq.current) return;
        setFreshGroups(groupsSig(g) !== groupsSig(groups) ? g : null);
      }
      setErr(null);
      setLastOk(Date.now());
    } catch (e) {
      if (my === loadSeq.current) fail(e);
    }
  }, [view, filter, page, groups, fail]);
  useEffect(() => {
    if (tab !== "logs") return;
    const t = setInterval(() => void poll(), REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, poll]);

  const openById = useCallback(async (id: string) => {
    setDetailMiss(null);
    try {
      const v = await apiGet<unknown>(logItemUrl(id));
      const raw = typeof v === "object" && v !== null && "item" in v ? (v as { item: unknown }).item : v;
      const e = parseLogEntry(raw);
      if (e) setDetail(e);
      else setDetailMiss({ id, error: new Error("항목 형식이 스키마와 맞지 않음") });
    } catch (e) {
      setDetailMiss({ id, error: e });
      if (isAuthMiss(e)) authMiss(e);
    }
  }, [authMiss]);
  // #id=… 로 열었으면 그 항목(GET /api/v1/ops/logs/{id})
  useEffect(() => {
    if (!init.openId) return;
    const t = setTimeout(() => void openById(init.openId!), 0);
    return () => clearTimeout(t);
  }, [init.openId, openById]);
  // 같은 화면에서 #rid= · #fp= · #id= 링크를 눌렀을 때(오류 문구 · 상세의 요청 id 링크)
  useEffect(() => {
    const onHash = () => {
      const h = parseLogsHash(window.location?.hash ?? "");
      if (h.rid || h.fp) {
        setTab("logs"); setView("list");
        setFilter((f) => ({ ...f, ...(h.rid ? { rid: h.rid, period: "7d" as const } : {}), ...(h.fp ? { fp: h.fp } : {}) }));
        if (h.rid) { setDraftRid(h.rid); setRidError(null); }
      }
      if (h.id) void openById(h.id);
    };
    window.addEventListener?.("hashchange", onHash);
    return () => window.removeEventListener?.("hashchange", onHash);
  }, [openById]);

  // 키보드로 고른 줄을 보이게
  useEffect(() => { if (selId) rowEls.current.get(selId)?.scrollIntoView?.({ block: "nearest" }); }, [selId]);

  const items = page?.items ?? [];
  const selIdx = items.findIndex((e) => e.id === selId);

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
    const p = parseLogPage(await apiGet<unknown>(logsUrl({ ...filter, q: "", rid: "", fp: g.fp }, Date.now(), { limit: LOGS_PAGE_MAX })));
    const truncated = p.nextCursor != null || p.scanTruncated === true || (g.count != null && p.items.length < g.count);
    return groupText(g, p.items, { truncated });
  });
  const showPending = () => {
    if (pending.more) { void load("list", filter); return; } // 새 항목이 한 쪽을 넘음 — 사이가 비지 않게 처음부터
    setPage((p) => (p ? { ...p, items: applyPending(p.items, pending.items) } : p));
    setPending(NO_PENDING);
  };
  const loadMore = async () => {
    if (!page?.nextCursor) return;
    const my = loadSeq.current;
    try {
      const p = parseLogPage(await apiGet<unknown>(logsUrl(filter, page.at, { cursor: page.nextCursor })));
      if (my !== loadSeq.current) return;
      setPage((prev) => (prev ? { ...appendLogPage(prev, p), at: prev.at } : prev));
    } catch (e) {
      fail(e);
    }
  };
  /** 목록 표(grid)에 초점이 있을 때만 — 다른 요소(단추 · 입력)에서 올라온 키는 그 요소의 것이다 */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey || e.ctrlKey || e.metaKey || view !== "list" || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = selIdx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, selIdx + (e.key === "ArrowDown" ? 1 : -1)));
      setSelId(items[i].id);
    } else if (e.key === "Enter" && selIdx >= 0) {
      e.preventDefault();
      setDetail(items[selIdx]);
      setDetailMiss(null);
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
  const filterFp = useCallback((fp: string) => { setView("list"); setFilter((f) => ({ ...f, fp })); }, []);
  /** 요청 id 로 거르기(상세 · 오류 문구) — 요청 시각을 모르므로 가장 긴 기간 */
  const filterRid = useCallback((rid: string) => {
    setTab("logs"); setView("list"); setDraftRid(rid); setRidError(null);
    setFilter((f) => ({ ...f, rid, period: "7d" }));
  }, []);
  const openEntry = useCallback((e: LogEntry) => { setDetail(e); setDetailMiss(null); }, []);
  const closeDetail = useCallback(() => { setDetail(null); setDetailMiss(null); }, []);
  const logout = () => { void signOut(() => apiSend("DELETE", OPS_SESSION_PATH), onLeave); };

  return (
    <div className="flex h-full flex-col" data-testid="logs-dashboard">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-3 py-1">
        <span className="label mr-2">System logs</span>
        <div className="flex gap-1" role="group" aria-label="로그 탭">
          <button type="button" className="btn" aria-pressed={tab === "logs"} onClick={() => setTab("logs")}>로그</button>
          <button type="button" className="btn" aria-pressed={tab === "gaps"} onClick={() => setTab("gaps")}>AIS 수신 공백</button>
        </div>
        {tab === "logs" ? <>
          <button type="button" className="btn" onClick={() => void load(view, filter)} disabled={loading}>새로 고침</button>
          <span className="mono text-[11px] text-fg-3" title="마지막 성공 응답 시각 — 15 s 마다 새 항목을 확인(목록은 단추를 눌러야 바뀜)" data-testid="logs-last-ok">갱신 {fmtClock(lastOk)} · 15 s 확인</span>
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
            {page?.scanned != null ? <span className="text-fg-3" title="마지막 요청이 훑은 스트림 항목 수(요청당 상한 3,000)">훑은 항목 <span className="mono">{n(page.scanned)}</span></span> : null}
            {page?.scanTruncated ? <span className="text-warn">스캔 상한(3,000)에서 잘림 — 조건에 맞는 더 오래된 항목이 있을 수 있음</span> : null}
            {page && (page.invalid > 0 || (page.serverInvalid ?? 0) > 0) ? (
              <span className="text-warn" data-testid="logs-skipped" title="api = 서버가 읽을 때 스키마 검증에 실패해 건너뛴 항목 · 화면 = 이 화면이 형식 오류로 버린 항목 — 둘 다 불러온 쪽들의 합(— = api 가 값을 주지 않음)">
                형식 오류로 건너뜀({page.pages > 1 ? `불러온 ${page.pages}쪽 합계` : "불러온 1쪽"}): api {page.serverInvalid ?? "—"} · 화면 {page.invalid}
              </span>
            ) : null}
            {pending.items.length ? (
              <button type="button" className="btn border-accent! text-accent!" data-testid="logs-new" onClick={showPending}>
                {pending.more ? `새 항목 ${n(pending.items.length)}건 이상 — 다시 불러오기` : `새 항목 ${n(pending.items.length)}건`}
              </button>
            ) : null}
            <span className="ml-auto flex gap-1">
              <button type="button" className="btn" onClick={() => void copy(`보이는 목록 ${n(items.length)}건`, logsText(items))} disabled={!items.length}>보이는 목록 복사</button>
              <button type="button" className="btn normal-case!" onClick={() => download("txt")} disabled={!items.length} title="보이는 목록 — 텍스트">.txt</button>
              <button type="button" className="btn normal-case!" onClick={() => download("ndjson")} disabled={!items.length} title="보이는 목록 — 한 줄에 항목 하나(JSON, api 가 준 그대로)">.ndjson</button>
            </span>
          </> : <>
            <span>{groups ? `묶음 ${n(groups.groups.length)}개(최근 ${LOG_PERIOD_LABEL[filter.period]})` : loading ? "불러오는 중…" : "—"}</span>
            {groups?.scanned != null ? <span className="text-fg-3">훑은 항목 <span className="mono">{n(groups.scanned)}</span></span> : null}
            {groups?.scanTruncated ? <span className="text-warn">스캔 상한(3,000)에서 잘림 — 묶음·건수가 기간의 일부만</span> : null}
            {groups?.invalid ? <span className="text-warn">형식 오류 묶음 {groups.invalid}개 건너뜀</span> : null}
            {freshGroups ? <button type="button" className="btn border-accent! text-accent!" data-testid="logs-new" onClick={() => { setGroups(freshGroups); setFreshGroups(null); }}>묶음에 새 항목 — 반영</button> : null}
            <span className="text-fg-3">묶음 보기는 서비스·수준·기간만 적용(글자 검색·요청 id·지문 제외)</span>
          </>}
          <span role="status" aria-live="polite" data-testid="logs-note" className={note?.ok === false ? "text-bad" : "text-ok"}>{note?.text ?? ""}</span>
        </div>
        <div className="shrink-0 border-b border-line px-3 py-1 text-[10px] text-fg-3">
          수집: api · collector · ais 의 WARN·ERROR(비밀값 가림) + 브라우저 오류(web-client — 브라우저가 보낸 내용, 검증 안 됨) · 스트림 wakeline:logs 는 최근 약 3,000건만 보관 ·
          edge(nginx) 로그는 컨테이너 표준 출력에만(수집 에이전트 없음) · 키보드(목록): ↑/↓ 이동 · Enter 상세 · c 텍스트 복사
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label="로그 목록" data-testid="log-list">
            {view === "list" ? <>
              {items.length ? (
                // 키보드: 표(grid)에 초점을 두고 고른 줄은 aria-activedescendant 로 알린다(화면 읽기 프로그램이 그 줄을 읽는다)
                <table role="grid" aria-readonly="true" tabIndex={0} onKeyDown={onKey} aria-label="로그 목록 — ↑/↓ 이동 · Enter 상세 · c 텍스트 복사"
                  aria-activedescendant={selIdx >= 0 ? rowDomId(items[selIdx].id) : undefined} data-testid="log-grid">
                  <thead className="sticky top-0 bg-bg-1"><tr>
                    <th scope="col">시각(UTC)</th><th scope="col">수준</th><th scope="col">서비스</th><th scope="col">로거</th><th scope="col">메시지(첫 줄)</th>
                    <th scope="col" title="직전 전송 뒤 같은 지문으로 보내지 않은 건수 — — = 필드 없음">억제</th><th scope="col">요청 id</th>
                  </tr></thead>
                  <tbody>{items.map((e) => (
                    <tr key={e.id} id={rowDomId(e.id)} data-testid="log-row" data-id={e.id} aria-selected={e.id === selId}
                      ref={(el) => { if (el) rowEls.current.set(e.id, el); else rowEls.current.delete(e.id); }}
                      onClick={() => { setSelId(e.id); openEntry(e); }}
                      className={`cursor-pointer ${e.id === selId ? "bg-[#1c2a3f]" : "hover:bg-bg-2"} ${detail?.id === e.id ? "outline outline-1 -outline-offset-1 outline-accent" : ""}`}>
                      <td className="mono whitespace-nowrap">{fmtLogTime(e.ts)}</td>
                      <td><span className={LEVEL_BADGE[e.level]}>{e.level}</span></td>
                      <td className="mono whitespace-nowrap">{e.service}{e.untrusted ? <span className="badge ml-1 normal-case!" title="브라우저가 보낸 내용 — 검증 안 됨">untrusted</span> : null}</td>
                      <td className="mono max-w-[240px] truncate text-fg-2" title={e.logger ?? ""}>{e.logger ?? "—"}</td>
                      <td className="max-w-[560px] truncate" title={firstLine(e.message)}>{firstLine(e.message)}</td>
                      <td className="mono text-right">{e.suppressed ?? "—"}</td>
                      <td className="mono whitespace-nowrap text-fg-3">{e.request_id ?? "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : page ? (
                <div className="p-3 text-fg-3" data-testid="logs-empty">
                  조건에 맞는 항목 없음(최근 {LOG_PERIOD_LABEL[filter.period]}){page.scanTruncated ? " — 스캔 상한에서 잘려 더 오래된 항목은 확인하지 못함" : ""}
                </div>
              ) : null}
              {page?.nextCursor ? (
                <button type="button" className="btn m-2" onClick={() => void loadMore()} title={`cursor ${page.nextCursor}`}>이전 항목 더 보기</button>
              ) : page && items.length ? <div className="p-2 text-[11px] text-fg-3">끝 — 다음 커서 없음</div> : null}
            </> : groups ? (
              groups.groups.length ? (
                <table>
                  <thead className="sticky top-0 bg-bg-1"><tr>
                    <th scope="col">지문(fp)</th><th scope="col">수준</th><th scope="col">서비스</th><th scope="col">로거 · 예외 종류</th><th scope="col">표본 메시지</th>
                    <th scope="col">항목</th><th scope="col" title="같은 지문으로 보내지 않은 건수의 합">억제 합</th><th scope="col">처음(UTC)</th><th scope="col">마지막(UTC)</th><th scope="col"></th>
                  </tr></thead>
                  <tbody>{groups.groups.map((g) => (
                    <tr key={g.fp} data-testid="log-group">
                      <td className="mono">{g.fp}</td>
                      <td>{g.level ? <span className={LEVEL_BADGE[g.level] ?? "badge"}>{g.level}</span> : "—"}</td>
                      <td className="mono">{g.service ?? "—"}</td>
                      <td className="max-w-[280px]"><div className="mono truncate" title={g.logger ?? ""}>{g.logger ?? "—"}</div><div className="mono truncate text-fg-3">{g.exception_type ?? "—"}</div></td>
                      <td className="max-w-[420px] truncate" title={g.sample_message ?? ""}>{g.sample_message ? firstLine(g.sample_message) : "—"}</td>
                      <td className="mono text-right">{g.count ?? "—"}</td>
                      <td className="mono text-right">{g.suppressed ?? "—"}</td>
                      <td className="mono whitespace-nowrap">{fmtTime(g.first_at)}</td>
                      <td className="mono whitespace-nowrap">{fmtTime(g.last_at)}</td>
                      <td className="whitespace-nowrap">
                        <button type="button" className="btn mr-1" onClick={() => filterFp(g.fp)}>목록으로</button>
                        <button type="button" className="btn" onClick={() => void copyGroup(g)}>묶음 복사</button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className="p-3 text-fg-3" data-testid="logs-empty">조건에 맞는 묶음 없음(최근 {LOG_PERIOD_LABEL[filter.period]})</div>
            ) : null}
          </div>
          {/* 상세는 목록의 항목 — 묶음 보기에서는 접어 둔다(상태는 남는다) */}
          {view === "list" && (detail || detailMiss) ? (
            <aside className="max-h-[50%] min-h-0 overflow-auto border-t border-line bg-bg-1 lg:max-h-none lg:w-[46%] lg:border-t-0 lg:border-l" aria-label="항목 상세">
              {detail ? (
                <LogDetail key={detail.id} entry={detail} period={filter.period} onClose={closeDetail} onOpen={openEntry} onFilterFp={filterFp} onFilterRid={filterRid} onCopy={(l, t) => void copy(l, t)} onAuthMiss={authMiss} />
              ) : detailMiss ? (
                <div className="p-3 text-[12px]" data-testid="log-detail-miss">
                  <div className="mb-1"><span className="label mr-2">항목</span><span className="mono">{detailMiss.id}</span></div>
                  <div className="text-bad">
                    항목을 열지 못함 — 스트림에서 잘렸거나(최근 약 3,000건만 보관) id 가 틀림 · <ErrorNote error={detailMiss.error} onFilterRid={filterRid} />
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
