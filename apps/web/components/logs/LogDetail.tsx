"use client";
import { useEffect, useState } from "react";
import { logGroups, logsPage } from "@/lib/endpoints/logs";
import { fmtIsoKst } from "@/lib/time";
import {
  DEFAULT_LOG_FILTER, entryKey, exceptionTypeText, firstLine, groupCountText, logJson, logLinkHash, LOG_PERIOD_LABEL, LOG_STREAM_KEEP, LOG_STREAM_KEY, LOG_STREAM_LABEL,
  logText, type LogEntry, type LogGroup, type LogPeriod,
} from "@/lib/logs";
import { isAuthMiss } from "@/lib/ops";
import { uptoOf, type ResolvedMode } from "@/lib/resolutions";
import { ErrorNote, RequestIdCopy } from "./ErrorNote";
import { KstTime } from "../KstTime";
import { ResolveConfirm, useResolveSlot, type ResolveResult, type ResolveTarget } from "../ResolveConfirm";
import { resolveLogGroup, revokeLogGroup } from "./logGroupTargets";

const LEVEL_BADGE: Record<string, string> = { ERROR: "badge bad", WARN: "badge warn" };
/** 같은 요청 id 항목을 찾는 범위(요청은 짧다 — 스트림 보관 전체에 가깝게) */
const RELATED_PERIOD: LogPeriod = "7d";
const RELATED_LIMIT = 50;

/**
 * 항목 상세(계약 v5 §C7): 전체 메시지 · 예외 종류·메시지 · 스택(mono, 줄바꿈 전환) · context · 같은 지문 묶음 통계 · 같은 요청 id 의 다른 항목.
 * 복사: 항목 텍스트(머리 줄 시각 KST +09:00) · 항목 JSON(api 가 준 그대로 — ts 는 서버 형식 …Z) · 항목 링크(/logs#id=…). 바뀐 항목마다 새로 마운트한다(key) — 앞 항목의 조회 결과가 남지 않게.
 * 시각은 KST 만(계약 v5 §G20 · lib/time) — 이 항목의 시각 칸은 KST ISO 8601(+09:00, ms 까지). 메시지 · 예외 · 스택 · context 는 서버가 기록한 글자 그대로(data-raw).
 * 같은 요청 id 의 다른 항목 표는 머리글이 없어 시각 칸에 KST 를 보이게 적는다.
 * 해결(ADR-024): 해결은 지문 묶음 단위 — "해결 처리"는 이 항목의 시각(서버가 쓴 ts 그대로)까지 이 지문을 해결로 적는다(확인 · 메모 선택).
 * 해결된 항목은 "해결됨 · <by> · <upto>" + "되돌리기". 쓰기 결과는 onResolveChanged 로 — 부모가 목록과 이 항목을 다시 읽는다(201/204 뒤에만 바뀐다).
 * 같은 지문 묶음 통계는 목록의 해결 표시(resolvedMode)를 따르고, 같은 요청 id 의 다른 항목은 해결 여부와 무관하게 모두(증거의 흐름 — 해결된 것은 표시).
 */
export function LogDetail({ entry, period, resolvedMode, onClose, onOpen, onFilterFp, onFilterRid, onCopy, onAuthMiss, onResolveChanged }: {
  entry: LogEntry; period: LogPeriod; resolvedMode: ResolvedMode; onClose: () => void; onOpen: (e: LogEntry) => void; onFilterFp: (fp: string) => void;
  onFilterRid: (rid: string) => void; onCopy: (label: string, text: string) => void; onAuthMiss: (e: unknown) => Promise<"expired" | "error">;
  onResolveChanged: (r: ResolveResult) => void;
}) {
  const [wrap, setWrap] = useState(true);
  const { open: confirm, show, close, closeIf, panelId, openerProps } = useResolveSlot();
  const setConfirm = (t: ResolveTarget) => show("entry", t);
  const [related, setRelated] = useState<{ items: LogEntry[]; more: boolean } | null>(null);
  const [relatedErr, setRelatedErr] = useState<unknown>(null);
  const [fpStats, setFpStats] = useState<{ g: LogGroup | null; scanTruncated: boolean | null } | null>(null);
  const [fpErr, setFpErr] = useState<unknown>(null);
  /*
   * 두 훑기(서버가 스트림을 최대 4,200 건 훑는다)는 그 값이 바뀔 때만 다시 한다 — 항목 객체가 바뀌었다고(해결 쓰기 뒤 낙관적 표시 · 다시 읽은 항목) 두 번 하지 않는다.
   * resolvedId = 이 항목의 해결(없으면 null): 해결 · 되돌림으로 바뀌면 한 번 다시 읽는다(묶음 통계는 가림을 따르고, 같은 요청 id 항목의 "해결됨" 표시도 바뀔 수 있다).
   */
  const key = entryKey(entry);
  const { request_id: rid, fp, service, level } = entry;
  const resolvedId = entry.resolved?.id ?? null;
  // 같은 요청 id 의 다른 항목 — 해결 여부와 무관하게 모두(resolved=show), 목록의 해결 표시를 따르지 않는다
  useEffect(() => {
    if (!rid) return;
    let live = true;
    logsPage({ ...DEFAULT_LOG_FILTER, period: RELATED_PERIOD, rid, resolved: "show" }, Date.now(), { limit: RELATED_LIMIT })
      .then((p) => { if (!live) return; setRelated({ items: p.items.filter((x) => entryKey(x) !== key), more: p.nextCursor != null || p.scanTruncated === true }); setRelatedErr(null); })
      .catch((e: unknown) => { if (!live) return; setRelatedErr(e); if (isAuthMiss(e)) onAuthMiss(e); });
    return () => { live = false; };
  }, [key, rid, resolvedId, onAuthMiss]);
  // 같은 지문 묶음 통계 — 목록의 해결 표시(resolvedMode)를 따른다
  useEffect(() => {
    if (!fp) return;
    let live = true;
    logGroups({ services: [service], level, period, resolved: resolvedMode }, Date.now())
      .then((g) => { if (!live) return; setFpStats({ g: g.groups.find((x) => x.fp === fp) ?? null, scanTruncated: g.scanTruncated }); setFpErr(null); })
      .catch((e: unknown) => { if (!live) return; setFpErr(e); if (isAuthMiss(e)) onAuthMiss(e); });
    return () => { live = false; };
  }, [fp, service, level, period, resolvedMode, resolvedId, onAuthMiss]);
  const upto = uptoOf(entry.ts);
  const res = entry.resolved;
  // 해결됨 · 해결되지 않음의 단추는 같은 자리의 하나(같은 DOM 요소) — 해결 · 되돌린 뒤 초점이 그 단추에 남는다
  const resolveCell = !res && !entry.fp ? <span data-testid="log-detail-resolve" className="text-fg-3">— (지문 없음 — 해결은 지문 묶음 단위)</span>
    : !res && !upto ? <span data-testid="log-detail-resolve" className="text-fg-3">— (시각 형식을 몰라 해결 범위(upto)를 정할 수 없음)</span>
    : (
      <span data-testid="log-detail-resolve" className={res ? "text-fg-3" : undefined}>
        {res ? <span>해결됨 · <span className="mono">{res.resolved_by}</span> · <KstTime v={res.upto} /></span> : <span className="text-fg-2">해결되지 않음</span>}
        <button type="button" className="btn ml-1 px-1.5! py-0! normal-case!" {...openerProps("entry")}
          title={res ? undefined : "이 항목의 시각까지 이 지문 묶음을 해결로 적는다 — 확인 창이 먼저 범위를 말한다"}
          onClick={() => setConfirm(res ? revokeLogGroup(res, entry.fp) : resolveLogGroup(entry.fp!, upto!, "이 항목의 시각 — 이 항목과 그보다 앞선 같은 지문 항목"))}>{res ? "되돌리기" : "해결 처리"}</button>
      </span>
    );
  const link = () => `${typeof window !== "undefined" ? window.location?.origin ?? "" : ""}/logs${logLinkHash(entry)}`;
  const keep = entry.stream ? LOG_STREAM_KEEP[entry.stream] : LOG_STREAM_KEEP.server;
  const row = (label: string, value: React.ReactNode) => <tr><th scope="row" className="w-28 align-top">{label}</th><td>{value}</td></tr>;
  const ex = entry.exception;
  return (
    <div className="p-3 text-[12px]" data-testid="log-detail">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="label mr-1">항목 상세</span>
        <span className={LEVEL_BADGE[entry.level]}>{entry.level}</span>
        <span className="mono text-fg-3">{entry.id}</span>
        <span className="ml-auto flex flex-wrap gap-1">
          <button type="button" className="btn" onClick={() => onCopy("항목 텍스트", logText(entry))} title="머리 줄 시각은 KST(ISO 8601 +09:00)">텍스트 복사</button>
          <button type="button" className="btn" onClick={() => onCopy("항목 JSON", logJson(entry))} title="api 가 준 그대로 — ts 는 서버 형식 ‘…Z’(KST 보다 9시간 이르다)">JSON 복사</button>
          <button type="button" className="btn" onClick={() => onCopy("항목 링크", link())} title={`운영 로그인 필요 — 스트림에서 잘리면(이 스트림은 최근 약 ${keep.toLocaleString("en-US")}건만 보관) 열리지 않음`}>링크 복사</button>
          <button type="button" className="btn" onClick={onClose}>닫기</button>
        </span>
      </div>
      {entry.untrusted ? <div className="mb-2 border border-warn/40 px-2 py-1 text-[11px] text-warn">브라우저가 보낸 내용(web-client) — 검증되지 않았으므로 사실로 믿지 마세요.</div> : null}
      <table className="mb-3">
        <tbody>
          {row("시각(KST)", <span data-testid="log-detail-time"><span className="mono">{fmtIsoKst(entry.ts)}</span></span>)}
          {row("서비스", <span className="mono">{entry.service}</span>)}
          {row("스트림", entry.stream
            ? <span><span className="mono">{LOG_STREAM_KEY[entry.stream]}</span> <span className="text-fg-3">— {LOG_STREAM_LABEL[entry.stream]}(최근 약 {LOG_STREAM_KEEP[entry.stream].toLocaleString("en-US")}건 보관)</span></span>
            : <span className="text-fg-3">— (api 가 주지 않음)</span>)}
          {row("인스턴스", <span className="mono">{entry.instance ?? "—"}</span>)}
          {row("스레드", <span className="mono">{entry.thread ?? "—"}</span>)}
          {row("로거", <span className="mono break-all">{entry.logger ?? "—"}</span>)}
          {row("요청 id", entry.request_id ? <RequestIdCopy id={entry.request_id} onFilter={onFilterRid} /> : <span className="text-fg-3">— (필드 없음)</span>)}
          {row("지문(fp)", entry.fp ? <span className="flex flex-wrap items-center gap-1"><span className="mono select-all">{entry.fp}</span><button type="button" className="btn px-1.5! py-0! normal-case!" onClick={() => onFilterFp(entry.fp!)}>이 묶음만 목록</button></span> : "—")}
          {row("억제", entry.suppressed == null ? <span className="text-fg-3">— (필드 없음)</span> : <span><span className="mono">{entry.suppressed}</span>건 <span className="text-fg-3">— 직전 전송 뒤 같은 지문이라 보내지 않은 수</span></span>)}
          {row("해결", resolveCell)}
        </tbody>
      </table>
      {confirm ? (
        <ResolveConfirm key={confirm.n} id={panelId("entry")} target={confirm.target} onClose={close} onAuthMiss={onAuthMiss} onFilterRid={onFilterRid}
          onChanged={(r) => { if (r.complete) closeIf(confirm.n); onResolveChanged(r); }} />
      ) : null}
      <div className="label mb-1">메시지</div>
      <pre className="mono mb-3 whitespace-pre-wrap break-words border border-line bg-bg p-2 text-[11px]" data-raw="log">{entry.message || "—"}</pre>
      <div className="label mb-1">예외</div>
      <div className="mono mb-3 break-words text-[11px]">{ex ? <>
        <span className="text-bad" data-testid="log-exception" title={ex.type.trim() ? undefined : "예외 종류 모름 — 브라우저 오류는 종류를 보내지 않음(빈 값)"}>{exceptionTypeText(ex.type)}</span>{ex.message != null ? <span data-raw="log">: {ex.message}</span> : ""}
      </> : <span className="text-fg-3">없음(예외 없는 {entry.level})</span>}</div>
      {ex ? <>
        <div className="mb-1 flex items-center gap-2">
          <span className="label">스택</span>
          <button type="button" className="btn px-1.5! py-0! normal-case!" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>줄바꿈 {wrap ? "켬" : "끔"}</button>
        </div>
        <pre data-testid="log-stack" data-raw="log" className={`mono mb-3 max-h-[40vh] overflow-auto border border-line bg-bg p-2 text-[11px] text-fg-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>{ex.stack || "스택 없음"}</pre>
      </> : null}
      <div className="label mb-1">context</div>
      {Object.keys(entry.context).length ? (
        <table className="mb-3" data-raw="log"><tbody>{Object.entries(entry.context).map(([k, v]) => <tr key={k}><th scope="row" className="w-40 normal-case! mono">{k}</th><td className="mono break-all">{v === null ? "null" : String(v)}</td></tr>)}</tbody></table>
      ) : <div className="mb-3 text-fg-3">없음</div>}
      <div className="label mb-1">같은 지문 묶음(최근 {LOG_PERIOD_LABEL[period]} · {entry.service} · {entry.level} · 해결된 항목 {resolvedMode === "show" ? "포함" : "제외"})</div>
      <div className="mb-3" data-testid="log-fp-stats">
        {!entry.fp ? <span className="text-fg-3">지문 없음</span>
          : fpErr ? <span className="text-bad"><ErrorNote error={fpErr} onFilterRid={onFilterRid} /></span>
          : !fpStats ? <span className="text-fg-3">불러오는 중…</span>
          : !fpStats.g ? <span className="text-fg-3">이 기간의 묶음에 없음{fpStats.scanTruncated ? "(스캔 상한에서 잘림)" : ""}</span>
          : <span className="mono">
              항목 {groupCountText(fpStats.g.count)} · 억제 합 {fpStats.g.suppressed ?? "—"} · 처음 <KstTime v={fpStats.g.first_at} /> · 마지막 <KstTime v={fpStats.g.last_at} />
              {fpStats.scanTruncated ? <span className="ml-1 text-warn">(스캔 상한에서 잘림 — 일부만 셈)</span> : null}
            </span>}
      </div>
      <div className="label mb-1">같은 요청 id 의 다른 항목(최근 {LOG_PERIOD_LABEL[RELATED_PERIOD]} · 해결된 항목 포함)</div>
      {!entry.request_id ? <div className="text-fg-3">요청 id 없음</div>
        : relatedErr ? <div className="text-bad"><ErrorNote error={relatedErr} onFilterRid={onFilterRid} /></div>
        : !related ? <div className="text-fg-3">불러오는 중…</div>
        : !related.items.length ? <div className="text-fg-3">없음</div>
        : <table><tbody>{related.items.map((r) => (
            <tr key={entryKey(r)} data-testid="log-related" className="cursor-pointer hover:bg-bg-2" onClick={() => onOpen(r)}>
              <td className="whitespace-nowrap"><KstTime v={r.ts} ms /></td><td><span className={LEVEL_BADGE[r.level]}>{r.level}</span></td>
              <td className="mono">{r.service}</td><td className="mono max-w-[200px] truncate" title={r.logger ?? ""}>{r.logger ?? "—"}</td><td className="max-w-[320px] truncate"><span title={firstLine(r.message)} data-raw="log">{firstLine(r.message)}</span></td>
              <td>{r.resolved ? <span className="badge normal-case!" title={`해결 #${r.resolved.id} · ${r.resolved.resolved_by}`}>해결됨</span> : null}</td>
            </tr>))}</tbody></table>}
      {related?.more ? <div className="mt-1 text-[11px] text-warn">더 있을 수 있음(목록 상한 {RELATED_LIMIT}건 또는 스캔 잘림)</div> : null}
    </div>
  );
}
