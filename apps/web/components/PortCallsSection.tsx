import { DualTime } from "@/components/DualTime";
import {
  gapText, legText, noExitTitle, portCallStatusText, portText, reportTime, PORT_CALL_AUTHORITIES, PORT_CALL_CAVEAT, PORT_CALL_INDEX_AS_OF_TITLE, PORT_CALL_MAX_ITEMS,
  PORT_CALL_SOURCE, PORT_CALL_SOURCE_URL, PORT_CALL_TITLE, PORT_CALL_WINDOW_DAYS, reportedNameNotes, windowText,
  type PortCall, type PortCallRevision, type PortCallsInfo,
} from "@/lib/portcalls";

/**
 * 신고 시각 한 칸: 공유 형식기의 표 칸(DualTime cell — 첫 줄 KST · 둘째 줄 흐린 UTC, 머리글 "(KST · UTC)", title 에 원본 UTC — 계약 v5 §G13).
 * KST 00:00 신고는 날짜만 · "시각 미확인"(UTC 로 바꾸지 않는다 — ADR-022). 판(최종 · 최초)을 아래에 적는다. 모르면 "—" 만.
 */
function When({ at, revision, testId }: { at: string | null; revision: PortCallRevision | null; testId: string }) {
  const t = reportTime(at);
  if (t == null) return <span className="text-fg-3" data-testid={testId}>—</span>;
  return (
    <span className="flex flex-col" data-testid={testId}>
      {t.dateOnly ? (
        <span className="flex flex-col" title={t.title} data-testid="port-call-date-only">
          <span className="mono">{t.kst}</span>
          <span className="text-[10px] text-fg-3">시각 미확인(00:00 신고)</span>
        </span>
      ) : <DualTime v={at} variant="cell" />}
      {revision ? <span className="text-[10px] text-fg-3" title="PORT-MIS 신고의 판(최종 신고가 있으면 최종, 없으면 최초)">{revision} 신고</span> : null}
    </span>
  );
}

/**
 * 한국 항만 입출항(ADR-022 개정): 서버 수집기가 해양수산부 PORT-MIS 의 항만청 10곳 신고를 KST 날짜별로 모두 받아 둔 색인에서, 고른 선박의 AIS
 * 호출부호로 찾은 것(api 가 ship_selected.port_calls 로 보낸다 — 고를 때 외부에 묻지 않는다). 상태마다 문구(기록 없음 · 색인 불완전 — 어느 항만청이
 * 왜 · 꺼짐 · 호출부호를 아직 받지 않음 · 읽기 실패), 결과는 신고마다 블록(항만청 · 입항 · 출항 KST+UTC · 선석 · 목적 · 전출항지 → 차항지). 색인 상태 한 줄
 * ("색인: 10개 항만청 · 최근 30일 · 갱신 <KST · UTC>"). PORT-MIS 신고 선명이 AIS 선명과 다르면(둘 다 영문일 때만) 경고로 밝힌다.
 * calls 가 null(서버가 보내지 않음 · 형식 오류)이면 "—".
 */
export function PortCallsSection({ calls, aisName }: { calls: PortCallsInfo | null; aisName: string | null }) {
  const status = calls ? portCallStatusText(calls) : null;
  const warn = calls != null && (calls.status === "incomplete" || calls.status === "disabled" || calls.status === "no_call_sign");
  const tone = calls?.status === "error" ? "text-bad" : warn ? "text-warn" : "text-fg-2";
  return (
    <section className="mt-2" data-testid="port-calls" data-status={calls?.status ?? "unknown"} aria-labelledby="port-calls-title">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <h3 id="port-calls-title" className="label normal-case!">{PORT_CALL_TITLE}</h3>
        {calls?.call_sign ? <span className="mono text-[10px] text-fg-3" title="찾는 데 쓴 AIS 호출부호(정규화 — 대문자)">호출부호 {calls.call_sign}</span> : null}
      </div>
      {calls == null ? <div className="text-[11px] text-fg-3" data-testid="port-calls-status">—</div>
        : calls.status !== "ok" ? (
          <div className={`text-[11px] ${tone}`} role={calls.status === "error" ? "alert" : undefined} data-testid="port-calls-status">
            {status}
            {calls.status === "incomplete" && calls.index ? <GapList calls={calls} /> : null}
          </div>
        ) : <PortCallTable calls={calls} aisName={aisName} />}
      {calls?.index ? <IndexLine calls={calls} /> : null}
      <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-caveat">{PORT_CALL_CAVEAT}</div>
      <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-attribution">
        출처 <a href={PORT_CALL_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{PORT_CALL_SOURCE} · 공공데이터포털</a>
      </div>
    </section>
  );
}

/**
 * "색인: 10개 항만청 · 최근 30일 · 갱신 <KST · UTC>" — 갱신 시각 = 10곳의 꼬리 갱신(최근 3일 다시 받기) 중 가장 오래된 것(모르면 "—"), 그리고 창(KST 날짜).
 * 그 시각이 말하는 것은 최근 3일뿐이다 — 더 오래된 날은 하루에 한 번쯤 다시 받으므로 그보다 이른 때까지의 신고일 수 있다(title 이 밝힌다).
 */
function IndexLine({ calls }: { calls: PortCallsInfo }) {
  const ix = calls.index!;
  return (
    <div className="mt-0.5 text-[10px] text-fg-3" data-testid="port-calls-index">
      <span>색인: {PORT_CALL_AUTHORITIES}개 항만청 · 최근 {PORT_CALL_WINDOW_DAYS}일 · 갱신 </span>
      <span title={PORT_CALL_INDEX_AS_OF_TITLE}>
        {ix.refreshed_at ? <DualTime v={ix.refreshed_at} seconds={false} /> : "—"}
      </span>
      <span className="block" data-testid="port-calls-window">{windowText(calls)}{ix.complete ? "" : " · 색인 불완전"}</span>
    </div>
  );
}

/** 색인 빈 곳: 항만청마다 무엇이(색인 안 됨 · 창 앞쪽 일부만 · 오늘 목록 아직 · 갱신 오래됨 · 끝까지 색인하지 못한 날)와 마지막 갱신 시각. */
function GapList({ calls }: { calls: PortCallsInfo }) {
  return (
    <ul className="mt-0.5 list-none text-[10px] text-fg-2" data-testid="port-calls-gaps">
      {calls.index!.gaps.map((g) => (
        <li key={g.port_authority_code} data-testid="port-calls-gap">
          {gapText(g)}
          {g.issues.includes("stale") ? (
            <span className="text-fg-3"> · 마지막 갱신 {g.refreshed_at ? <DualTime v={g.refreshed_at} seconds={false} /> : "없음(아직 한 번도 끝나지 않음)"}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
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
              ? <>PORT-MIS 선명 {name} — AIS 선명({ais})과 표기 체계가 달라 비교하지 않음</>
              : <>PORT-MIS 선명 {name} — AIS 선명 없음(비교 불가)</>}
          </div>
        ))}
      <div className="mb-0.5 text-[10px] text-fg-3" data-testid="port-calls-reported">
        최근 신고 선종 {newest.kind ?? "—"} · 국적 {newest.nationality ?? "—"}
      </div>
      {/* 신고마다 라벨 · 값 두 열 블록 — 선박 카드는 좁은 옆 칸이라 6열 표는 선석 이름을 한 글자씩 접었다(설명서 캡처로 확인) */}
      <ol className="flex flex-col gap-1.5 text-[11px]" data-testid="port-calls-table" aria-label={`입출항 신고 ${calls.items.length}건`}>
        {calls.items.map((c, i) => (
          <li key={`${c.port_authority_code ?? "?"}-${c.listed_date ?? "?"}-${c.entry_at ?? c.exit_at ?? i}-${i}`}
            className="border-l-2 border-line py-0.5 pl-2" data-testid="port-call-row">
            <div className="font-semibold text-fg">
              {c.port_authority ?? "—"}
              {c.port_authority_code ? <span className="mono font-normal text-fg-3" title="항만청 코드(PORT-MIS prtAgCd)"> · {c.port_authority_code}</span> : null}
            </div>
            <dl className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
              <dt className="text-fg-3" title="첫 줄 한국 표준시(UTC+9) · 둘째 줄 UTC — 00:00(KST) 신고는 날짜만">입항</dt>
              <dd><When at={c.entry_at} revision={c.entry_revision} testId="port-call-entry" /></dd>
              <dt className="text-fg-3" title="첫 줄 한국 표준시(UTC+9) · 둘째 줄 UTC — 출항 신고가 없으면 —(아직 입항 중일 수 있다)">출항</dt>
              <dd><Exit c={c} /></dd>
              <dt className="text-fg-3" title="입항 신고의 계류 시설(PORT-MIS laidupFcltyNm)">선석</dt>
              <dd className="break-keep">{c.berth ?? "—"}</dd>
              <dt className="text-fg-3">목적</dt>
              <dd>{c.purpose ?? "—"}</dd>
              <dt className="text-fg-3" title="전출항지 → 차항지(PORT-MIS 신고)">항로</dt>
              <dd>
                <span className="block">{legText(c)}</span>
                {c.dest_port && portText(c.dest_port) !== portText(c.next_port) ? (
                  <span className="block text-[10px] text-fg-3">목적지 {portText(c.dest_port)}</span>
                ) : null}
                {c.first_port && portText(c.first_port) !== portText(c.prev_port) ? (
                  <span className="block text-[10px] text-fg-3">최초 출항지 {portText(c.first_port)}</span>
                ) : null}
              </dd>
            </dl>
          </li>
        ))}
      </ol>
      {calls.truncated ? <div className="mt-0.5 text-[10px] text-warn" data-testid="port-calls-truncated">최근 {PORT_CALL_MAX_ITEMS}건만 표시 — 더 있음</div> : null}
      {calls.index && !calls.index.complete ? (
        <div className="mt-0.5 text-[10px] text-warn" data-testid="port-calls-incomplete">
          색인이 아직 완전하지 않아 목록이 빠졌을 수 있음
          <GapList calls={calls} />
        </div>
      ) : null}
    </>
  );
}

/** 출항 칸: 시각이 있으면 그 시각 · 없으면 "—"(title — 아직 입항 중이거나 색인이 그 뒤를 다시 읽지 않았을 수 있다). */
function Exit({ c }: { c: PortCall }) {
  if (c.exit_at == null) return <span className="text-fg-3" title={noExitTitle(c)} data-testid="port-call-exit">—</span>;
  return <When at={c.exit_at} revision={c.exit_revision} testId="port-call-exit" />;
}
