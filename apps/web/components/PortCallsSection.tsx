import {
  callTimes, kstUtc, legText, portCallStatusText, portText, PORT_CALL_CAVEAT, PORT_CALL_MAX_ITEMS, PORT_CALL_PAGE_CAP, PORT_CALL_SOURCE, PORT_CALL_SOURCE_URL,
  PORT_CALL_ERROR_WHERE, PORT_CALL_TITLE,
  reportedNameMismatches, windowText, type PortCall, type PortCallsInfo,
} from "@/lib/portcalls";

/** 시각 한 칸: KST 위 · UTC 아래(같은 순간) · 툴팁 원본 UTC ISO. 모르면 "—" 만 */
function When({ at }: { at: string | null }) {
  const t = kstUtc(at);
  if (t.utc == null) return <span className="text-fg-3">—</span>;
  return (
    <span className="flex flex-col" title={t.title}>
      <span className="mono">{t.kst}</span>
      <span className="mono text-[10px] text-fg-3">{t.utc}</span>
    </span>
  );
}

/** 입항·출항 한 칸: 정해진 시각 · 시각이 서로 다른 신고 여럿(모두 · "신고 n건") · 모름 */
function CallTime({ c, kind }: { c: PortCall; kind: "입항" | "출항" }) {
  const t = callTimes(c, kind);
  if (t.single) return <When at={t.single} />;
  if (t.reports.length) {
    return (
      <span className="flex flex-col gap-0.5" data-testid="port-call-ambiguous">
        <span className="text-[10px] text-warn">{kind} 신고 {t.reports.length}건 · 시각 다름</span>
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
  const tone = calls?.status === "error" ? "text-bad" : calls?.status === "disabled" || calls?.status === "no_call_sign" ? "text-warn" : "text-fg-2";
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
      {calls != null && calls.status !== "no_call_sign" ? (
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

function FetchedAt({ at }: { at: string }) {
  const t = kstUtc(at);
  return <span className="mono" title={t.title}>{t.kst}{t.utc ? ` (${t.utc})` : ""}</span>;
}

function PortCallTable({ calls, aisName }: { calls: PortCallsInfo; aisName: string | null }) {
  const names = reportedNameMismatches(calls.items, aisName);
  const newest = calls.items[0];
  return (
    <>
      {names.map((n) => (
        <div key={n} className="mb-0.5 text-[11px] text-warn" data-testid="port-calls-name-mismatch">
          {aisName && aisName.trim() ? <>PORT-MIS 선명 {n} — AIS 선명({aisName.trim()})과 다름</> : <>PORT-MIS 선명 {n} — AIS 선명 없음(비교 불가)</>}
        </div>
      ))}
      <div className="mb-0.5 text-[10px] text-fg-3" data-testid="port-calls-reported">
        최근 신고 선종 {newest.kind ?? "—"} · 국적 {newest.nationality ?? "—"}
      </div>
      <table className="text-[11px]" data-testid="port-calls-table">
        <thead>
          <tr>
            <th scope="col" className="px-1 py-1">항만청</th>
            <th scope="col" className="px-1 py-1">입항</th>
            <th scope="col" className="px-1 py-1">출항</th>
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
