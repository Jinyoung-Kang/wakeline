"use client";
import { Fragment } from "react";
import { exceptionTypeText, firstLine, type LogGroup } from "@/lib/logs";
import { BULK_CONCURRENCY, RESOLVE_EFFECT, uptoOf } from "@/lib/resolutions";
import { DualTime } from "../DualTime";
import { ResolveConfirm, useResolveSlot, type ResolveResult } from "../ResolveConfirm";
import { resolveLogGroup, revokeLogGroup } from "./logGroupTargets";

const LEVEL_BADGE: Record<string, string> = { ERROR: "badge bad", WARN: "badge warn" };
/** 표의 칸 수(확인 패널 줄의 colSpan) */
const COLS = 11;

/** 일괄 해결 대상: 해결되지 않았고 마지막 시각(upto 로 보낼 서버 시각)을 아는 묶음. 나머지는 뺀 이유별로 센다 */
export function bulkPlan(groups: readonly LogGroup[]): { eligible: { g: LogGroup; upto: string }[]; resolved: number; noTime: number } {
  const eligible: { g: LogGroup; upto: string }[] = [];
  let resolved = 0, noTime = 0;
  for (const g of groups) {
    const upto = uptoOf(g.last_at);
    if (g.resolved) resolved++;
    else if (!upto) noTime++;
    else eligible.push({ g, upto });
  }
  return { eligible, resolved, noTime };
}

/**
 * 지문(fp) 묶음 표 + 해결(ADR-024). 묶음마다 "해결 처리"(upto = 그 묶음의 마지막 항목 시각 last_at — 서버가 준 글자 그대로),
 * 해결된 묶음(보일 때)은 흐리게 "해결됨 · <by> · <upto>" + "되돌리기". 위쪽 "보이는 묶음 모두 해결 처리"는 확인 창이 수(와 뺀 것)를 먼저 말하고
 * 묶음마다 요청 하나(동시에 최대 4)를 보낸다. 쓰기 결과는 onChanged 로 — 부모가 목록을 다시 읽는다(201/204 뒤에만 바뀐다).
 */
export function LogGroupsTable({ groups, onFilterFp, onCopyGroup, onChanged, onAuthMiss, onFilterRid }: {
  groups: LogGroup[]; onFilterFp: (fp: string) => void; onCopyGroup: (g: LogGroup) => void; onChanged: (r: ResolveResult) => void;
  onAuthMiss: (e: unknown) => Promise<"expired" | "error">; onFilterRid: (rid: string) => void;
}) {
  /** 확인 패널이 열린 자리: 묶음 하나(fp) 또는 일괄("bulk") — 한 번에 하나만 */
  const { open, show, close, closeIf, panelId, openerProps } = useResolveSlot();
  const plan = bulkPlan(groups);
  const n = plan.eligible.length;
  const excluded = [plan.resolved ? `이미 해결됨 ${plan.resolved}개` : null, plan.noTime ? `마지막 시각 모름 ${plan.noTime}개` : null].filter(Boolean).join(" · ");
  const openBulk = () => show("bulk", {
    op: "resolve", effect: RESOLVE_EFFECT.log_group, excluded: excluded ? `제외: ${excluded}` : null,
    drafts: plan.eligible.map(({ g, upto }) => ({ kind: "log_group", key: g.fp, upto })),
    subject: <>보이는 묶음 {n}개를 해결 처리합니다 — 묶음마다 그 묶음의 마지막 항목 시각(last_at)까지 · 요청 {n}건(묶음마다 1건 · 동시에 최대 {BULK_CONCURRENCY}건)</>,
  });
  const panel = (at: string) => (open?.at === at ? (
    <ResolveConfirm key={open.n} id={panelId(at)} target={open.target} onClose={close} onAuthMiss={onAuthMiss} onFilterRid={onFilterRid}
      onChanged={(r) => { if (r.complete) closeIf(open.n); onChanged(r); }} />
  ) : null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1 text-[11px]" data-testid="log-groups-actions">
        <button type="button" className="btn" disabled={!n} onClick={openBulk} {...openerProps("bulk")}
          title={n ? `보이는 묶음마다 그 묶음의 마지막 항목 시각(last_at)까지 해결 처리 — 확인 창이 수를 먼저 말한다` : "해결 처리할 묶음 없음 — 보이는 묶음이 모두 해결됨이거나 마지막 시각을 모름"}>
          보이는 묶음 모두 해결 처리
        </button>
        <span className="text-fg-3">대상 <span className="mono">{n}</span>개 / 보이는 묶음 <span className="mono">{groups.length}</span>개{excluded ? ` · 제외: ${excluded}` : ""}</span>
      </div>
      {open?.at === "bulk" ? <div className="px-3">{panel("bulk")}</div> : null}
      <table>
        <thead className="sticky top-0 bg-bg-1"><tr>
          <th scope="col">지문(fp)</th><th scope="col">수준</th><th scope="col">서비스</th><th scope="col">로거 · 예외 종류</th><th scope="col">표본 메시지</th>
          <th scope="col">항목</th><th scope="col" title="같은 지문으로 보내지 않은 건수의 합">억제 합</th><th scope="col">처음(KST · UTC)</th><th scope="col">마지막(KST · UTC)</th>
          <th scope="col" title="해결 처리(ADR-024): 지문 묶음을 upto(마지막 항목 시각)까지 해결로 적는다 — 지우지 않고 가린다, upto 뒤 재발은 다시 보인다">해결</th><th scope="col"></th>
        </tr></thead>
        <tbody>{groups.map((g) => {
          const upto = uptoOf(g.last_at);
          const res = g.resolved;
          return (
            <Fragment key={g.fp}>
              <tr data-testid="log-group" data-resolved={res ? "true" : undefined} className={res ? "text-fg-3" : undefined}>
                <td className="mono">{g.fp}</td>
                <td>{g.level ? <span className={LEVEL_BADGE[g.level] ?? "badge"}>{g.level}</span> : "—"}</td>
                <td className="mono">{g.service ?? "—"}</td>
                <td className="max-w-[280px]"><div className="mono truncate" title={g.logger ?? ""}>{g.logger ?? "—"}</div><div className="mono truncate text-fg-3" title={g.exception_type === "" ? "예외 종류 모름(브라우저 오류는 종류를 보내지 않음)" : undefined}>{exceptionTypeText(g.exception_type)}</div></td>
                <td className="max-w-[420px] truncate" title={g.sample_message ?? ""}>{g.sample_message ? firstLine(g.sample_message) : "—"}</td>
                <td className="mono text-right">{g.count ?? "—"}</td>
                <td className="mono text-right">{g.suppressed ?? "—"}</td>
                <td className="whitespace-nowrap"><DualTime v={g.first_at} variant="cell" /></td>
                <td className="whitespace-nowrap"><DualTime v={g.last_at} variant="cell" /></td>
                {/* 해결 · 되돌리기는 같은 자리의 단추 하나(같은 DOM 요소) — 해결 뒤 초점이 그 행의 "되돌리기"에 남는다 */}
                <td className="min-w-[140px]">
                  {res ? <span data-testid="group-resolved-mark" className="mr-1">해결됨 · <span className="mono">{res.resolved_by}</span> · <DualTime v={res.upto} /></span> : null}
                  <button type="button" className={res ? "btn px-1.5! py-0! normal-case!" : "btn"} disabled={!res && !upto} {...openerProps(g.fp)}
                    aria-label={res ? `되돌리기: 지문 ${g.fp} 해결 #${res.id}` : `해결 처리: 지문 ${g.fp}`}
                    title={res ? undefined : upto ? "이 묶음의 마지막 항목 시각까지 해결로 적는다 — 확인 창이 먼저 범위를 말한다" : "마지막 시각 모름 — 해결 범위(upto)를 정할 수 없음"}
                    onClick={() => {
                      if (res) show(g.fp, revokeLogGroup(res, g.fp));
                      else if (upto) show(g.fp, resolveLogGroup(g.fp, upto, "이 묶음의 마지막 항목 시각"));
                    }}>{res ? "되돌리기" : "해결 처리"}</button>
                </td>
                <td className="whitespace-nowrap">
                  <button type="button" className="btn mr-1" onClick={() => onFilterFp(g.fp)}>목록으로</button>
                  <button type="button" className="btn" onClick={() => onCopyGroup(g)}>묶음 복사</button>
                </td>
              </tr>
              {open?.at === g.fp ? <tr><td colSpan={COLS}>{panel(g.fp)}</td></tr> : null}
            </Fragment>
          );
        })}</tbody>
      </table>
    </>
  );
}
