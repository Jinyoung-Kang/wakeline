"use client";
import { useEffect, useState } from "react";
import { KrRadarPanelPart } from "./DashboardParts";
import { useServerNow } from "@/lib/clock";
import { fmtKst, fmtKstMinute, fmtTimeTitle, kstWallMs } from "@/lib/time";
import { KR_REF_WINDOW_MIN, krComposite, krMissing, krPartialSummary, krTmClock, type KrMissingInfo } from "@/lib/kr-radar";
import { useServerData } from "@/lib/store";
import type { KrRadar } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

/**
 * 기상청을 골랐는데 쓸 수 있는 프레임이 없을 때(R-11) — 지도에 레이더가 없는 이유를 타임라인에 쓴다.
 * 서버가 준 note 와 마지막 수집 시각(meta.fetched_at)만 붙인다(모르면 붙이지 않는다).
 */
function krUnavailableText(d: KrRadar | null, miss: KrMissingInfo | null): string {
  if (!d) return "기상청 레이더 없음 — 상태 수신 전";
  const last = fmtKst(d.meta?.fetched_at);
  return `기상청 레이더 없음${d.note ? ` — ${d.note}` : ""}${miss ? ` — ${miss.text}` : ""}${last !== "—" ? ` · 마지막 수집 ${last}` : ""}`;
}

/**
 * 레이더 타임라인(FR-06): 과거 2 h · 10분 간격 프레임. 지도는 현재 프레임만 받아 그리고(PERF-12), 재생 중에만 다음 프레임을 미리 받는다.
 * RainViewer 는 커버리지 밖을 회색으로 가려 "에코 없음"과 구분한다(GAP-15).
 * 기상청(ADR-021): 지금 프레임의 합성 크기("합성 12/15곳")와 부분 합성 경고, 프레임 띠(프레임마다 부분 합성 · 기준 도달 · 판정 없음)를 함께 보인다 —
 * 부분 합성 프레임은 실자료라 숨기지 않지만 완전한 것처럼 보이지 않게. 기준 도달은 '완전'이 아니다(지난 60분 최대와 같을 뿐) — 초록(정상)이 아닌 파랑.
 */
export function RadarTimeline() {
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const source = useUi((s) => s.radarSource);
  const setSource = useUi((s) => s.setRadarSource);
  const rvIdx = useUi((s) => s.radarFrameIndex);
  const setRvIdx = useUi((s) => s.setRadarFrame);
  const krIdx = useUi((s) => s.krFrameIndex);
  const setKrIdx = useUi((s) => s.setKrFrame);
  const playing = useUi((s) => s.radarPlaying);
  const setPlaying = useUi((s) => s.setRadarPlaying);
  const kma = source === "kma";
  const n = kma ? radarKr?.frames.length ?? 0 : radar?.past.length ?? 0;
  const idx = kma ? krIdx : rvIdx;
  const setIdx = kma ? setKrIdx : setRvIdx;
  const cur = idx ?? Math.max(0, n - 1);
  useEffect(() => {
    if (!playing || n === 0) return;
    const t = setInterval(() => {
      const st = useUi.getState();
      const i = kma ? st.krFrameIndex : st.radarFrameIndex;
      setIdx(((i ?? n - 1) + 1) % n);
    }, 600);
    return () => clearInterval(t);
  }, [playing, n, setIdx, kma]);
  const time = kma ? undefined : radar?.past[cur]?.time;
  const krTm = kma ? radarKr?.frames[cur]?.tm : undefined;
  const krAvailable = !!radarKr?.available && (radarKr?.frames.length ?? 0) > 0;
  const srvNow = useServerNow(30_000);
  const krFrames = kma && krAvailable && radarKr ? radarKr.frames : null;
  const comp = krFrames ? krComposite(krFrames[cur], srvNow) : null;
  const krMiss = krMissing(radarKr?.missing, srvNow); // 기상청 내려받기 '파일 없음' 연속(2026-09-30) — 새 프레임이 오지 않는 까닭
  const miss = kma ? krMiss : null;
  // 프레임 시각은 둘 다 "MM-DD HH:MM KST"(계약 v5 §G20 — lib/time): RainViewer 는 epoch 초(순간), 기상청 tm 은 원래 KST(YYYYMMDDHHMM) —
  // 날짜가 바뀌는 자정 부근도 알 수 있게 월-일 포함
  const frameMs = kma ? kstWallMs(krTm) : time ? time * 1000 : null;
  const label = fmtKstMinute(frameMs, { date: true });
  // 툴팁: RainViewer 는 연도 · ms 까지의 같은 순간(KST), 기상청은 tm 이 원래 KST — 그 원문 tm 을 그대로 적는다
  const labelTitle = kma ? (label === "—" ? undefined : `기상청 tm ${krTm} — 기상청이 준 KST 그대로`) : fmtTimeTitle(frameMs);
  const [kr, setKr] = useState(false);
  return (
    <div className="relative flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-bg-1 px-3 py-1" data-testid="radar-timeline">
      {/* 범례·정합 패널은 단추를 누른 뒤에 받는다(DashboardParts — ADR-026) */}
      {kr ? <KrRadarPanelPart onClose={() => setKr(false)} /> : null}
      <span className="label">Radar</span>
      <button className="btn" aria-pressed={!kma} onClick={() => setSource("rainviewer")} data-testid="radar-src-rv">RainViewer</button>
      <button className="btn" aria-pressed={kma} onClick={() => setSource("kma")} disabled={!krAvailable} title={krAvailable ? "기상청 합성 HSR 500 m" : krMiss?.text || radarKr?.note || "수집 전"} data-testid="radar-src-kma">기상청 HSR</button>
      {/* '재생' 은 상단 메뉴(이력 재생 화면)의 이름이다 — 레이더 애니메이션은 다른 말로(R-60) */}
      <button className="btn" onClick={() => setPlaying(!playing)} disabled={n === 0} aria-pressed={playing} data-testid="radar-play"
        aria-label={playing ? "레이더 애니메이션 정지" : "레이더 애니메이션 재생"}>{playing ? "정지" : "애니메이션 ▶"}</button>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={cur} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="w-40 min-[900px]:w-64" disabled={n === 0}
        aria-label="레이더 프레임" aria-valuetext={label} />
      <span className="mono text-[11px]" title={labelTitle} data-testid="radar-frame-time">{label}</span>
      {comp ? <span className={`mono text-[11px] ${comp.warn ? "text-warn" : "text-fg-2"}`} title={comp.title} data-testid="kr-frame-composite">{comp.label}</span> : null}
      {comp?.warn ? <span className="badge warn normal-case!" title={comp.warn} data-testid="kr-frame-partial">일부 합성</span> : null}
      {miss && krAvailable ? <span className="badge warn normal-case!" data-testid="kr-frame-missing" title={`${miss.text}\n${miss.title}`}>{miss.word}</span> : null}
      {krFrames ? (
        <span className="flex h-3 items-stretch gap-px" data-testid="kr-frame-strip" role="img" aria-label={`프레임별 합성 상태 — 부분 합성 ${krPartialSummary(krFrames)}`}
          title={`프레임별 합성 상태(왼쪽이 오래된 프레임): 주황 = 일부 지점만 합성(기준 미만), 파랑 = 기준 도달(지난 ${KR_REF_WINDOW_MIN}분 최대와 같음 — 완전한지는 모름), 빈 칸 = 판정 없음 · 부분 합성 ${krPartialSummary(krFrames)}`}>
          {krFrames.map((f, i) => {
            const c = krComposite(f, srvNow);
            const st = c.state === "at_ref" ? "at_ref" : c.state === "unknown" ? "unknown" : "partial";
            return <span key={f.tm} data-kr-frame={f.tm} data-state={st} title={`${krTmClock(f.tm)} · ${c.label}${c.warn ? ` · ${c.warn}` : ""}`}
              className={`w-1.5 ${st === "partial" ? "bg-warn" : st === "at_ref" ? "bg-accent/70" : "border border-fg-3/60"} ${i === cur ? "outline outline-1 outline-fg" : ""}`} />;
          })}
        </span>
      ) : null}
      {kma && !krAvailable
        ? <span className="text-[10px] text-warn" data-testid="radar-kr-unavailable">{krUnavailableText(radarKr, miss)}</span>
        : <span className="text-[10px] text-fg-3">{kma ? `${n} frames · 5 min · 기상청 HSR 500 m(LCC→Mercator 재투영)` : `${n} frames · 10 min · RainViewer(z≤7) · 커버리지 밖 회색`}</span>}
      <button className="btn" onClick={() => { setPlaying(false); setIdx(null); }} disabled={n === 0} title="최신 프레임으로" data-testid="radar-latest">latest</button>
      <button className="btn ml-2" aria-pressed={kr} onClick={() => setKr(!kr)} data-testid="kr-radar-toggle">범례·정합</button>
    </div>
  );
}
