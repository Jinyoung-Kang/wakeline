"use client";
import { EvidenceCard } from "./EvidenceCard";
import { KstRange, KstTime } from "./KstTime";
import { alertJson, evidencePosition, missingCopies, type AlertDetail } from "@/lib/alert-detail";
import { downloadText } from "@/lib/copy";
import { alertZone, closeReasonLabel } from "@/lib/alerts";
import { fmtAltDual } from "@/lib/format";
import { fmtKst, RAW_BULLETIN_LABEL, RAW_BULLETIN_TITLE } from "@/lib/time";

/**
 * 알림 근거 한 장(app/alerts/[id] — SPEC F5): 머리 · 내려받기 · 인쇄 · 근거 카드 · 판정 때 위치(좌표 표) · 구역 사본. 인쇄해도 같은 내용(단추만 빠진다).
 * DB 없이 온 답(meta.db_unavailable — 열린 알림의 사본은 메모리 값)은 그렇다고 적고, 알림이 가리키는데 응답에 없는 사본은 칸을 빼지 않고 '사본을 읽지 못함'으로(IM-20).
 */
export function AlertSheet({ d }: { d: AlertDetail }) {
  const a = d.alert;
  const z = alertZone(a);
  const pos = evidencePosition(a);
  const ev = (a.evidence ?? {}) as Record<string, unknown>;
  const miss = missingCopies(d);
  const save = () => {
    const now = Date.now();
    downloadText(`wakeline-alert-${a.id}.json`, alertJson(d, fmtKst(now), new Date(now).toISOString()), "application/json");
  };
  return (
    <div className="max-w-[720px] text-[12px]" data-testid="alert-sheet">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold">{a.callsign?.trim() || "호출부호 —"} <span className="mono text-fg-3">({a.hex})</span></span>
        <span>{z.kind} · {z.label} · {z.sub}</span>
        <span className={a.left_at ? "text-fg-3" : "text-warn"} data-testid="alert-state">{a.left_at ? <>닫힘 <KstTime v={a.left_at} /> · {closeReasonLabel(a.close_reason)}</> : "열림(지금 판정 중)"}</span>
        <span className="text-fg-3">진입 <KstTime v={a.entered_at} /> · 출처 {d.source === "engine" ? "엔진(실시간)" : "기록(DB)"}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1 print:hidden">
        <button className="btn" onClick={save} data-testid="alert-download">JSON 내려받기</button>
        <button className="btn" onClick={() => window.print()}>인쇄</button>
      </div>
      <section className="mb-3"><EvidenceCard a={a} standalone /></section>
      <section className="panel mb-3 p-2" data-testid="alert-position">
        <div className="label mb-1">판정 때 위치(지도 대신 좌표)</div>
        <table className="w-full"><tbody>
          <tr><th scope="row" className="text-left font-normal text-fg-3">위도 · 경도</th><td className="mono text-right">{pos ? `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}` : "—"}</td></tr>
          <tr><th scope="row" className="text-left font-normal text-fg-3">고도</th><td className="mono text-right">{fmtAltDual(a.alt_ft)}</td></tr>
          <tr><th scope="row" className="text-left font-normal text-fg-3">관측 시각 · 출처</th><td className="text-right"><KstTime v={typeof ev.seen_at === "string" ? ev.seen_at : null} /> · {typeof ev.provider === "string" ? ev.provider : "—"}</td></tr>
        </tbody></table>
      </section>
      {d.dbUnavailable ? <div className="mb-3 text-[11px] text-warn" data-testid="alert-db-unavailable">DB 일시 사용 불가 — 판정 사본을 메모리 값으로 보입니다(저장 사본 아님)</div> : null}
      {d.sigmet ? (
        <section className="panel mb-3 p-2" data-testid="alert-sigmet-copy">
          <div className="label mb-1">SIGMET 사본 · {d.sigmet.fir_id} · {d.sigmet.hazard}{d.sigmet.qualifier ? ` ${d.sigmet.qualifier}` : ""}</div>
          <div>유효 <KstRange a={d.sigmet.valid_from} b={d.sigmet.valid_to} />{d.sigmet.withdrawn_at ? <> · 철회 <KstTime v={d.sigmet.withdrawn_at} /></> : null}</div>
          <div className="label mt-1" title={RAW_BULLETIN_TITLE}>원문({RAW_BULLETIN_LABEL})</div>
          <pre className="mono whitespace-pre-wrap text-[11px]" title={RAW_BULLETIN_TITLE} data-raw="bulletin">{d.sigmet.raw_text}</pre>
        </section>
      ) : miss.sigmet ? (
        <section className="panel mb-3 p-2" data-testid="alert-sigmet-missing">
          <div className="label mb-1">SIGMET 사본 · {a.fir_id ?? "—"} · {a.hazard ?? "—"}{a.qualifier ? ` ${a.qualifier}` : ""}</div>
          <div className="text-warn">사본을 읽지 못함</div>
        </section>
      ) : null}
      {d.airspace ? (
        <section className="panel mb-3 p-2" data-testid="alert-airspace-copy">
          <div className="label mb-1">공역 사본 · {d.airspace.type_ko}</div>
          <div>{d.airspace.ident ? `${d.airspace.ident} ` : ""}{d.airspace.name}</div>
          <div>고도 한계(원문) 하한 <span className="mono">{d.airspace.lower_raw}</span> · 상한 <span className="mono">{d.airspace.upper_raw}</span></div>
          <div className="text-fg-3">기준 차수 {d.airspace.edition}{d.airspace.edition_active ? "" : " (지금 쓰는 차수 아님)"} · 국토교통부 · 최신 여부 확인 안 함</div>
        </section>
      ) : miss.airspace ? (
        <section className="panel mb-3 p-2" data-testid="alert-airspace-missing">
          <div className="label mb-1">공역 사본 · {a.airspace?.type_ko ?? "—"} · {a.airspace?.label ?? "—"}</div>
          <div className="text-warn">사본을 읽지 못함</div>
        </section>
      ) : null}
      <div className="text-[10px] text-fg-3">시각은 한국 표준시(KST). 닫힌 알림은 {d.retentionDays}일 보존 — 그 뒤에는 이 링크로 볼 수 없습니다.</div>
    </div>
  );
}
