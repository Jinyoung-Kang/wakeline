"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtTime } from "@/lib/format";
import {
  DEFAULT_LOG_FILTER, firstLine, fmtLogTime, logGroupsUrl, logJson, LOG_PERIOD_LABEL, logsUrl, logText, parseLogGroups, parseLogPage,
  type LogEntry, type LogGroup, type LogPeriod,
} from "@/lib/logs";
import { isAuthMiss } from "@/lib/ops";
import { ErrorNote, RequestIdCopy } from "./ErrorNote";

const LEVEL_BADGE: Record<string, string> = { ERROR: "badge bad", WARN: "badge warn" };
/** 같은 요청 id 항목을 찾는 범위(요청은 짧다 — 스트림 보관 전체에 가깝게) */
const RELATED_PERIOD: LogPeriod = "7d";
const RELATED_LIMIT = 50;

/**
 * 항목 상세(계약 v5 §C7): 전체 메시지 · 예외 종류·메시지 · 스택(mono, 줄바꿈 전환) · context · 같은 지문 묶음 통계 · 같은 요청 id 의 다른 항목.
 * 복사: 항목 텍스트 · 항목 JSON(api 가 준 그대로) · 항목 링크(/logs#id=…). 바뀐 항목마다 새로 마운트한다(key) — 앞 항목의 조회 결과가 남지 않게.
 */
export function LogDetail({ entry, period, onClose, onOpen, onFilterFp, onCopy, onAuthMiss }: {
  entry: LogEntry; period: LogPeriod; onClose: () => void; onOpen: (e: LogEntry) => void; onFilterFp: (fp: string) => void;
  onCopy: (label: string, text: string) => void; onAuthMiss: (e: unknown) => void;
}) {
  const [wrap, setWrap] = useState(true);
  const [related, setRelated] = useState<{ items: LogEntry[]; more: boolean } | null>(null);
  const [relatedErr, setRelatedErr] = useState<unknown>(null);
  const [fpStats, setFpStats] = useState<{ g: LogGroup | null; scanTruncated: boolean | null } | null>(null);
  const [fpErr, setFpErr] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const now = Date.now();
    const failTo = (set: (e: unknown) => void) => (e: unknown) => { if (!live) return; set(e); if (isAuthMiss(e)) onAuthMiss(e); };
    if (entry.request_id) {
      apiGet<unknown>(logsUrl({ ...DEFAULT_LOG_FILTER, period: RELATED_PERIOD, rid: entry.request_id }, now, { limit: RELATED_LIMIT }))
        .then((v) => { if (!live) return; const p = parseLogPage(v); setRelated({ items: p.items.filter((x) => x.id !== entry.id), more: p.nextCursor != null || p.scanTruncated === true }); })
        .catch(failTo(setRelatedErr));
    }
    if (entry.fp) {
      apiGet<unknown>(logGroupsUrl({ services: [entry.service], level: entry.level, period }, now))
        .then((v) => { if (!live) return; const g = parseLogGroups(v); setFpStats({ g: g.groups.find((x) => x.fp === entry.fp) ?? null, scanTruncated: g.scanTruncated }); })
        .catch(failTo(setFpErr));
    }
    return () => { live = false; };
  }, [entry, period, onAuthMiss]);
  const link = () => `${typeof window !== "undefined" ? window.location?.origin ?? "" : ""}/logs#id=${encodeURIComponent(entry.id)}`;
  const row = (label: string, value: React.ReactNode) => <tr><th scope="row" className="w-28 align-top">{label}</th><td>{value}</td></tr>;
  const ex = entry.exception;
  return (
    <div className="p-3 text-[12px]" data-testid="log-detail">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="label mr-1">항목 상세</span>
        <span className={LEVEL_BADGE[entry.level]}>{entry.level}</span>
        <span className="mono text-fg-3">{entry.id}</span>
        <span className="ml-auto flex flex-wrap gap-1">
          <button type="button" className="btn" onClick={() => onCopy("항목 텍스트", logText(entry))}>텍스트 복사</button>
          <button type="button" className="btn" onClick={() => onCopy("항목 JSON", logJson(entry))}>JSON 복사</button>
          <button type="button" className="btn" onClick={() => onCopy("항목 링크", link())} title="운영 로그인 필요 — 스트림에서 잘리면(최근 약 3,000건만 보관) 열리지 않음">링크 복사</button>
          <button type="button" className="btn" onClick={onClose}>닫기</button>
        </span>
      </div>
      {entry.untrusted ? <div className="mb-2 border border-warn/40 px-2 py-1 text-[11px] text-warn">브라우저가 보낸 내용(web-client) — 검증되지 않았으므로 사실로 믿지 마세요.</div> : null}
      <table className="mb-3">
        <tbody>
          {row("시각(UTC)", <span className="mono">{new Date(entry.ts).toISOString()}</span>)}
          {row("서비스", <span className="mono">{entry.service}</span>)}
          {row("인스턴스", <span className="mono">{entry.instance ?? "—"}</span>)}
          {row("스레드", <span className="mono">{entry.thread ?? "—"}</span>)}
          {row("로거", <span className="mono break-all">{entry.logger ?? "—"}</span>)}
          {row("요청 id", entry.request_id ? <RequestIdCopy id={entry.request_id} /> : <span className="text-fg-3">— (필드 없음)</span>)}
          {row("지문(fp)", entry.fp ? <span className="flex flex-wrap items-center gap-1"><span className="mono select-all">{entry.fp}</span><button type="button" className="btn px-1.5! py-0! normal-case!" onClick={() => onFilterFp(entry.fp!)}>이 묶음만 목록</button></span> : "—")}
          {row("억제", entry.suppressed == null ? <span className="text-fg-3">— (필드 없음)</span> : <span><span className="mono">{entry.suppressed}</span>건 <span className="text-fg-3">— 직전 전송 뒤 같은 지문이라 보내지 않은 수</span></span>)}
        </tbody>
      </table>
      <div className="label mb-1">메시지</div>
      <pre className="mono mb-3 whitespace-pre-wrap break-words border border-line bg-bg p-2 text-[11px]">{entry.message || "—"}</pre>
      <div className="label mb-1">예외</div>
      <div className="mono mb-3 break-words text-[11px]">{ex ? <><span className="text-bad">{ex.type}</span>{ex.message != null ? `: ${ex.message}` : ""}</> : <span className="text-fg-3">없음(예외 없는 {entry.level})</span>}</div>
      {ex ? <>
        <div className="mb-1 flex items-center gap-2">
          <span className="label">스택</span>
          <button type="button" className="btn px-1.5! py-0! normal-case!" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>줄바꿈 {wrap ? "켬" : "끔"}</button>
        </div>
        <pre data-testid="log-stack" className={`mono mb-3 max-h-[40vh] overflow-auto border border-line bg-bg p-2 text-[11px] text-fg-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>{ex.stack || "스택 없음"}</pre>
      </> : null}
      <div className="label mb-1">context</div>
      {Object.keys(entry.context).length ? (
        <table className="mb-3"><tbody>{Object.entries(entry.context).map(([k, v]) => <tr key={k}><th scope="row" className="w-40 normal-case! mono">{k}</th><td className="mono break-all">{v === null ? "null" : String(v)}</td></tr>)}</tbody></table>
      ) : <div className="mb-3 text-fg-3">없음</div>}
      <div className="label mb-1">같은 지문 묶음(최근 {LOG_PERIOD_LABEL[period]} · {entry.service} · {entry.level})</div>
      <div className="mb-3" data-testid="log-fp-stats">
        {!entry.fp ? <span className="text-fg-3">지문 없음</span>
          : fpErr ? <span className="text-bad"><ErrorNote error={fpErr} /></span>
          : !fpStats ? <span className="text-fg-3">불러오는 중…</span>
          : !fpStats.g ? <span className="text-fg-3">이 기간의 묶음에 없음{fpStats.scanTruncated ? "(스캔 상한에서 잘림)" : ""}</span>
          : <span className="mono">
              항목 {fpStats.g.count ?? "—"}건 · 억제 합 {fpStats.g.suppressed ?? "—"} · 처음 {fmtTime(fpStats.g.first_at)} · 마지막 {fmtTime(fpStats.g.last_at)}
              {fpStats.scanTruncated ? <span className="ml-1 text-warn">(스캔 상한에서 잘림 — 일부만 셈)</span> : null}
            </span>}
      </div>
      <div className="label mb-1">같은 요청 id 의 다른 항목(최근 {LOG_PERIOD_LABEL[RELATED_PERIOD]})</div>
      {!entry.request_id ? <div className="text-fg-3">요청 id 없음</div>
        : relatedErr ? <div className="text-bad"><ErrorNote error={relatedErr} /></div>
        : !related ? <div className="text-fg-3">불러오는 중…</div>
        : !related.items.length ? <div className="text-fg-3">없음</div>
        : <table><tbody>{related.items.map((r) => (
            <tr key={r.id} data-testid="log-related" className="cursor-pointer hover:bg-bg-2" onClick={() => onOpen(r)}>
              <td className="mono whitespace-nowrap">{fmtLogTime(r.ts)}</td><td><span className={LEVEL_BADGE[r.level]}>{r.level}</span></td>
              <td className="mono">{r.service}</td><td className="mono max-w-[200px] truncate" title={r.logger ?? ""}>{r.logger ?? "—"}</td><td className="max-w-[320px] truncate" title={firstLine(r.message)}>{firstLine(r.message)}</td>
            </tr>))}</tbody></table>}
      {related?.more ? <div className="mt-1 text-[11px] text-warn">더 있을 수 있음(목록 상한 {RELATED_LIMIT}건 또는 스캔 잘림)</div> : null}
    </div>
  );
}
