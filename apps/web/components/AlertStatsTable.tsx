import type { AlertStatsRow } from "@/lib/stats";

/** 알림 통계의 날짜는 api 가 UTC 날짜로 센 값 — 한국 표준시 날짜로 옮기지 않는다 */
const UTC_DAY_TITLE = "UTC 날짜(api 가 UTC 날짜마다 센다) — 한국 표준시 날짜가 아니다: KST 09:00 에 날짜가 바뀐다";

/** 통계 화면의 알림 표(R-32): 날짜·종류마다 건수와 평균 체류를 따로 — 내부 지표 키를 보이지 않는다. */
export function AlertStatsTable({ rows }: { rows: AlertStatsRow[] }) {
  const mark = <span className="text-warn" title="수정 전 히스테리시스로 판정된 알림 포함 — 아래 주 참고" aria-label="수정 전 판정 포함"> †</span>;
  return (
    <table data-testid="alert-stats">
      <thead><tr><th scope="col" title={UTC_DAY_TITLE}>날짜(UTC 날짜)</th><th scope="col">종류</th><th scope="col">알림 건수</th><th scope="col">평균 체류</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.key}>
          <td className="mono">{r.day}</td><td>{r.kind}</td>
          <td className="mono">{r.count}{r.preFix && r.count !== "—" ? mark : null}</td>
          <td className="mono" title={r.dwellTitle}>{r.dwell}{r.preFix && r.dwell !== "—" ? mark : null}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
