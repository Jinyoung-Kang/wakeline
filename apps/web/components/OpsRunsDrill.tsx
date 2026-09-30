"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { isAuthMiss, RUN_STATUS_TITLE, runStatusClass } from "@/lib/ops";
import { appendRunsPage, RUNS_DRILL_LIMIT, runsDrillPath, type RunKey } from "@/lib/ops-runs";
import { KstTime } from "@/components/KstTime";
import { ErrorNote } from "@/components/logs/ErrorNote";

type Any = Record<string, unknown>;
interface RunsPage { items: Any[]; next_cursor?: unknown }

/** 원본 칸(실행 오류 글자) — 운영 화면의 RAW_RECORD_TITLE 과 같은 말 */
const RAW_TITLE = "원본 그대로(바꾸지 않음) — 안의 시각은 수집기가 쓴 형식 그대로(‘…Z’ 는 KST 보다 9시간 이르다), 옆 칸의 시각은 KST";

/**
 * 운영 RUNS 요약 행을 연 목록(errors F1): 그 job · provider · status 의 실행을 최신순으로 50건씩 — since = 연 때 받은 요약 응답의 summary_since(그때의
 * 24 h 창 — 요약은 15 s 마다 창이 앞으로 가지만 이 목록은 그대로라 머리글은 '연 때의 요약 창' 이라 하고 그 시각을 KST 로 적는다), 모르면 기간 제한 없이
 * (그렇다고 적는다). next_cursor 가 있으면 '더 보기'.
 * 목록은 증거라 해결 처리와 상관없이 모두 싣는다(요약의 n 은 해결 표시를 따른다 — 수가 다를 수 있다). 15 s 새로고침과 따로 — 연 때와 '다시 불러오기' 때만 부른다.
 * 실패는 패널에 요청 id 와 함께(몇 건인지 모르면 수를 적지 않는다). 401/404 는 세션 확인(onAuthMiss).
 */
export function OpsRunsDrill({ id, k, since, onClose, onAuthMiss }: {
  id: string; k: RunKey; since: string | null; onClose: () => void; onAuthMiss: (e: unknown) => void;
}) {
  const [items, setItems] = useState<Any[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  /** 요청 번호 — 다시 불러오기 · 닫기 뒤에 온 옛 응답은 버린다 */
  const seq = useRef(0);
  /** 세션 확인 콜백은 ref 로 — 부모가 그릴 때마다 새 함수를 줘도 목록을 다시 부르지 않는다(15 s 새로고침) */
  const authRef = useRef(onAuthMiss);
  useEffect(() => { authRef.current = onAuthMiss; }, [onAuthMiss]);
  const load = useCallback((cursor: number | null) => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    apiGet<RunsPage>(runsDrillPath(k, since, cursor)).then(
      (p) => {
        if (my !== seq.current) return;
        const got = Array.isArray(p.items) ? p.items : [];
        setItems((prev) => (cursor == null || prev == null ? got : appendRunsPage(prev, got)));
        setNext(typeof p.next_cursor === "number" ? p.next_cursor : null);
        setBusy(false);
      },
      (e: unknown) => {
        if (my !== seq.current) return;
        // 첫 쪽(다시 불러오기)이 실패하면 앞서 받은 목록을 지운다 — 옛 목록이 새 요청의 답처럼 남지 않게. '더 보기' 실패는 받은 쪽을 그대로 둔다
        if (cursor == null) { setItems(null); setNext(null); }
        setErr(e);
        setBusy(false);
        if (isAuthMiss(e)) authRef.current(e);
      });
  }, [k, since]);
  /** 떠 있는 응답을 버린다(닫기 · 열쇠가 바뀜) */
  const drop = useCallback(() => { seq.current++; }, []);
  useEffect(() => {
    const t = setTimeout(() => load(null), 0);
    return () => { clearTimeout(t); drop(); };
  }, [load, drop]);
  const label = `${k.job} · ${k.provider} · ${k.status}`;
  return (
    <div id={id} role="region" aria-label={`실행 목록: ${label}`} className="border-l-2 border-line-2 py-1 pl-2" data-testid="runs-drill">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="label normal-case!">Runs · <span className="mono">{k.job} · {k.provider} · </span><span className={`mono ${runStatusClass(k.status, "item")}`} title={RUN_STATUS_TITLE[k.status]}>{k.status}</span></span>
        <span className="text-fg-3" data-testid="runs-drill-window" title={since ? "요약은 15 s 마다 새로 받아 창이 앞으로 가지만, 이 목록의 창은 연 때 그대로다(다시 불러오기도 같은 창) — 닫고 다시 열면 그때의 창" : undefined}>
          {since ? <>연 때의 요약 창(24 h) — <KstTime v={since} /> 뒤에 시작한 실행</> : "기간 제한 없음(응답에 요약 창의 시작 summary_since 가 없음 — api 가 이 화면보다 옛 판일 수 있음)"}
          {" · 최신순 · 해결 처리와 상관없이 모두(증거 — 요약의 n 은 해결 표시를 따른다)"}
        </span>
        {items ? <span className="mono text-fg-2" data-testid="runs-drill-count">{items.length.toLocaleString("en-US")}건 · {next != null ? "더 있음" : "끝"}</span> : null}
        {busy ? <span className="text-fg-3" role="status">불러오는 중…</span> : null}
        <button className="btn normal-case!" onClick={() => load(null)} disabled={busy} title="첫 쪽부터 다시 받는다(창의 시작은 연 때 그대로)">다시 불러오기</button>
        <button className="btn normal-case!" onClick={onClose} data-testid="runs-drill-close">닫기</button>
      </div>
      {err ? <div className="mb-1 text-[11px] text-bad" role="alert" data-testid="runs-drill-failed"><ErrorNote prefix="실행 목록을 불러오지 못함 — " error={err} /></div> : null}
      {items ? (
        <table>
          <thead><tr><th>id</th><th>started (KST)</th><th>finished (KST)</th><th>http</th><th>ms</th><th>in / quarantined</th><th>raw_ref</th><th title={RAW_TITLE}>error (raw)</th></tr></thead>
          <tbody>{items.map((r) => (
            <tr key={String(r.id)} data-testid="runs-drill-row">
              <td className="mono">{String(r.id)}</td>
              <td className="whitespace-nowrap"><KstTime v={typeof r.started_at === "string" || typeof r.started_at === "number" ? r.started_at : null} variant="cell" /></td>
              <td className="whitespace-nowrap"><KstTime v={typeof r.finished_at === "string" || typeof r.finished_at === "number" ? r.finished_at : null} variant="cell" /></td>
              <td className="mono">{r.http_status == null ? "" : String(r.http_status)}</td>
              <td className="mono">{r.latency_ms == null ? "—" : String(r.latency_ms)}</td>
              <td className="mono">{String(r.records_in ?? "—")} / {String(r.records_quarantined ?? "—")}</td>
              <td className="mono text-fg-3">{String(r.raw_ref ?? "")}</td>
              <td>{typeof r.error_text === "string" && r.error_text ? <pre className="mono max-w-[480px] whitespace-pre-wrap text-[10px] text-fg-2" title={RAW_TITLE} data-raw="record" data-testid="runs-drill-error">{r.error_text}</pre> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      {items && next != null ? (
        <button className="btn mt-1 normal-case!" onClick={() => load(next)} disabled={busy} data-testid="runs-drill-more">더 보기(다음 {RUNS_DRILL_LIMIT}건)</button>
      ) : null}
    </div>
  );
}
