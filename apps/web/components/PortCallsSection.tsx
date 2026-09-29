import { DualTime } from "@/components/DualTime";
import {
  callTimes, legText, portCallStatusText, portText, reportTime, PORT_CALL_CAVEAT, PORT_CALL_MAX_ITEMS, PORT_CALL_PAGE_CAP, PORT_CALL_SOURCE,
  PORT_CALL_SOURCE_URL, PORT_CALL_ERROR_WHERE, PORT_CALL_TITLE,
  reportedNameNotes, windowText, type PortCall, type PortCallsInfo,
} from "@/lib/portcalls";

/**
 * 신고 시각 한 칸: 공유 형식기의 표 칸(DualTime cell — 첫 줄 KST · 둘째 줄 흐린 UTC, 머리글 "(KST · UTC)", title 에 원본 UTC — 계약 v5 §G13).
 * KST 00:00 신고는 날짜만 · "시각 미확인"(UTC 로 바꾸지 않는다 — ADR-022). 모르면 "—" 만.
 */
function When({ at }: { at: string | null }) {
  const t = reportTime(at);
  if (t == null) return <span className="text-fg-3">—</span>;
  if (t.dateOnly) {
    return (
      <span className="flex flex-col" title={t.title} data-testid="port-call-date-only">
        <span className="mono">{t.kst}</span>
        <span className="text-[10px] text-fg-3">시각 미확인(00:00 신고)</span>
      </span>
    );
  }
  return <DualTime v={at} variant="cell" />;
}

/** 입항·출항 한 칸: 정해진 시각 · 시각이 서로 다른 신고 여럿(모두) · 시각 없는 신고와 함께 온 시각 있는 신고 하나 · 모름 */
function CallTime({ c, kind }: { c: PortCall; kind: "입항" | "출항" }) {
  const t = callTimes(c, kind);
  if (t.single) return <When at={t.single} />;
  if (t.reports.length) {
    const undated = t.total - t.reports.length;
    const label = t.reports.length > 1
      ? `${kind} 신고 ${t.total}건 · 시각 다름${undated > 0 ? ` · 시각 없는 신고 ${undated}건` : ""}`
      : `${kind} 신고 ${t.total}건 중 시각 있는 1건`;
    return (
      <span className="flex flex-col gap-0.5" data-testid="port-call-ambiguous">
        <span className="text-[10px] text-warn">{label}</span>
        {t.reports.map((at) => <When key={at} at={at} />)}
      </span>
    );
  }
  return <span className="text-fg-3">—</span>;
}

/**
 * 한국 항만 입출항(ADR-022): 선박을 고르면 수집기가 그 선박의 AIS 호출부호로 해양수산부 PORT-MIS 에 묻고(최근 30일 · 항만청 10곳), api 가
 * ship_selected.port_calls 로 보낸 것을 그대로 보인다. 상태마다 문구(조회 중 · 기록 없음 · 키 없음 · 실패 사유 · 호출부호 없음), 결과는 표
 * (항만청 · 입항/출항 KST+UTC · 목적 · 전출항지 → 차항지). PORT-MIS 신고 선명이 AIS 선명과 다르면 경고로 밝힌다 — 같은 선박인지는 판정하지 않는다.
 * calls 가 null(서버가 보내지 않음 · 형식 오류)이면 "—".
 */
export function PortCallsSection({ calls, aisName }: { calls: PortCallsInfo | null; aisName: string | null }) {
  const status = calls ? portCallStatusText(calls) : null;
  const warn = calls != null && (calls.status === "disabled" || calls.status === "no_call_sign" || calls.status === "limited" || (calls.status === "none" && calls.incomplete));
  const tone = calls?.status === "error" ? "text-bad" : warn ? "text-warn" : "text-fg-2";
  return (
    <section className="mt-2" data-testid="port-calls" data-status={calls?.status ?? "unknown"} aria-labelledby="port-calls-title">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <h3 id="port-calls-title" className="label normal-case!">{PORT_CALL_TITLE}</h3>
        {calls?.call_sign ? <span className="mono text-[10px] text-fg-3" title="조회에 쓴 AIS 호출부호(정규화 — 대문자)">호출부호 {calls.call_sign}</span> : null}
      </div>
      {calls == null ? <div className="text-[11px] text-fg-3" data-testid="port-calls-status">—</div>
        : calls.status === "pending" ? (
          <div role="status" aria-live="polite" aria-busy="true" data-testid="port-calls-status">
            <div className="text-[11px] text-fg-2">{status}</div>
            <span className="wl-busy mt-1" aria-hidden="true" data-testid="port-calls-busy" />
          </div>
        )
        : calls.status !== "ok" ? (
          <div className={`text-[11px] ${tone}`} role={calls.status === "error" ? "alert" : undefined} data-testid="port-calls-status">
            {status}
            {calls.status === "error" ? <span className="block text-[10px] text-fg-3" data-testid="port-calls-error-where">{PORT_CALL_ERROR_WHERE}</span> : null}
          </div>
        ) : <PortCallTable calls={calls} aisName={aisName} />}
      {calls != null && calls.status !== "no_call_sign" && calls.status !== "no_static" ? (
        <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-window">
          {windowText(calls)}{calls.fetched_at ? <> · 조회 <FetchedAt at={calls.fetched_at} /></> : null}
        </div>
      ) : null}
      <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-caveat">{PORT_CALL_CAVEAT}</div>
      <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-attribution">
        출처 <a href={PORT_CALL_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{PORT_CALL_SOURCE} · 공공데이터포털</a>
      </div>
    </section>
  );
}

/** 조회 시각(우리 시각 — 늘 KST · UTC, 분까지): 공유 형식기 inline */
function FetchedAt({ at }: { at: string }) {
  return <DualTime v={at} seconds={false} />;
}

function PortCallTable({ calls, aisName }: { calls: PortCallsInfo; aisName: string | null }) {
  const names = reportedNameNotes(calls.items, aisName);
  const newest = calls.items[0];
  const ais = aisName?.trim();
  return (
    <>
      {names.map(({ name, note }) =>
        note === "differs" ? (
          <div key={name} className="mb-0.5 text-[11px] text-warn" data-testid="port-calls-name-mismatch">PORT-MIS 선명 {name} — AIS 선명({ais})과 다름</div>
        ) : (
          <div key={name} className="mb-0.5 text-[11px] text-fg-2" data-testid="port-calls-name-uncompared">
            {note === "other_script"
              ? <>PORT-MIS 선명 {name} — AIS 선명({ais})은 영문이라 표기 체계가 달라 비교하지 않음</>
              : <>PORT-MIS 선명 {name} — AIS 선명 없음(비교 불가)</>}
          </div>
        ))}
      <div className="mb-0.5 text-[10px] text-fg-3" data-testid="port-calls-reported">
        최근 신고 선종 {newest.kind ?? "—"} · 국적 {newest.nationality ?? "—"}
      </div>
      <table className="text-[11px]" data-testid="port-calls-table">
        <thead>
          <tr>
            <th scope="col" className="px-1 py-1">항만청</th>
            <th scope="col" className="px-1 py-1" title="첫 줄 한국 표준시(UTC+9) · 둘째 줄 UTC — 00:00(KST) 신고는 날짜만">입항(KST · UTC)</th>
            <th scope="col" className="px-1 py-1" title="첫 줄 한국 표준시(UTC+9) · 둘째 줄 UTC — 00:00(KST) 신고는 날짜만">출항(KST · UTC)</th>
            <th scope="col" className="px-1 py-1">목적</th>
            <th scope="col" className="px-1 py-1">전출항지 → 차항지</th>
          </tr>
        </thead>
        <tbody>
          {calls.items.map((c, i) => (
            <tr key={`${c.port_authority_code ?? "?"}-${c.entry_at ?? c.exit_at ?? i}-${i}`} data-testid="port-call-row">
              <td className="px-1 py-1">
                <span className="block">{c.port_authority ?? "—"}</span>
                {c.port_authority_code ? <span className="mono block text-[10px] text-fg-3" title="항만청 코드(PORT-MIS prtAgCd)">{c.port_authority_code}</span> : null}
              </td>
              <td className="px-1 py-1"><CallTime c={c} kind="입항" /></td>
              <td className="px-1 py-1"><CallTime c={c} kind="출항" /></td>
              <td className="px-1 py-1">{c.purpose ?? "—"}</td>
              <td className="px-1 py-1">
                <span className="block">{legText(c)}</span>
                {c.dest_port && portText(c.dest_port) !== portText(c.next_port) ? (
                  <span className="block text-[10px] text-fg-3">목적지 {portText(c.dest_port)}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {calls.truncated ? <div className="mt-0.5 text-[10px] text-warn" data-testid="port-calls-truncated">최근 {PORT_CALL_MAX_ITEMS}건만 표시 — 더 있음</div> : null}
      {calls.incomplete ? (
        <div className="mt-0.5 text-[10px] text-warn" data-testid="port-calls-incomplete">일부 항만청 기록이 조회 상한(항만청당 {PORT_CALL_PAGE_CAP}건)을 넘어 앞쪽만 받았습니다 — 목록이 완전하지 않음</div>
      ) : null}
    </>
  );
}
