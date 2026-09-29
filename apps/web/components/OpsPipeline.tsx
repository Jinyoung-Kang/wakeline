import { fmtKst, fmtKstRange, fmtTimeTitle } from "@/lib/time";
import { lastTrimLoss, pipelineRows, type PipelineGroup } from "@/lib/ops";
import { KstTime } from "./KstTime";

const GROUP_LABEL: Record<PipelineGroup, string> = { collector: "collector(수집)", ais: "ais(선박 수신)", api: "api(저장·배포)" };
const TONE: Record<string, string> = { bad: "text-bad font-semibold", warn: "text-warn font-semibold", ok: "text-ok", muted: "" };

/**
 * 운영 화면 "pipeline" 탭(R-18): 데이터 손실 신호(드롭·트림·저장 실패)를 한곳에. 0 이 아닌 손실 지표는 빨간색,
 * 스트림 보존 창이 바이트 예산 때문에 목표보다 짧으면 주황(손실 아님 — 공유 필드 계약 stream_window_s · stream_retention_s),
 * 모르는 값(collector·ais heartbeat 가 오래됐거나 필드 없음)은 "—" — 0 으로 보이지 않는다. 시각은 KST 만(계약 v5 §G19 · lib/time — "09-29 14:02:54 KST", title 에 연도 · ms 까지의 KST).
 */
export function OpsPipeline({ data }: { data: unknown }) {
  const rows = pipelineRows(data);
  const trim = lastTrimLoss(data);
  const raw = (data as { generated_at?: unknown } | null)?.generated_at;
  const at = typeof raw === "string" ? raw : null;
  return (
    <div data-testid="ops-pipeline">
      <div className="mb-2 text-[11px] text-fg-3">
        누적 값은 각 프로세스가 시작된 뒤의 합계입니다. 빨간 값 = 0 이 아닌 손실 지표 · 주황 = 예산 때문에 짧아진 스트림 보존 창(손실 아님) · “—” = 모름(heartbeat 오래됨·없음) · 생성 <KstTime v={at} />
      </div>
      <table>
        <thead><tr><th scope="col">구성 요소</th><th scope="col">지표</th><th scope="col">값</th><th scope="col">뜻</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={`${r.group}.${r.key}`} data-key={r.key} data-tone={r.tone}>
            <td>{GROUP_LABEL[r.group]}</td><td>{r.label} <span className="mono text-fg-3">{r.key}</span></td>
            <td className={`mono ${TONE[r.tone]}`}>{r.text}{r.detail ? <span className="text-fg-3"> · {r.detail}</span> : null}{r.state ? <> · {r.state}</> : null}</td><td className="text-fg-3">{r.title}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="mt-3 text-[11px]" data-testid="ops-pipeline-trim">
        <span className="label mr-2">마지막 트림 손실</span>
        {trim ? (
          <span className="mono text-bad" title={`${trim.from ? fmtTimeTitle(trim.from) ?? "—" : "시작 모름"} – ${fmtTimeTitle(trim.to) ?? "—"}`}>
            {trim.stream} · {trim.from ? fmtKstRange(trim.from, trim.to) : `시작 모름 – ${fmtKst(trim.to)}`}
          </span>
        ) : <span className="text-fg-3">기록 없음</span>}
      </div>
    </div>
  );
}
