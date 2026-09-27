"use client";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import {
  ALT_RAMP, ALT_UNKNOWN_COLOR, CAT_COLORS, CAT_STALE_FILL, CAT_STALE_STROKE, CAT_UNKNOWN_COLOR, HAZARD_LEGEND, METAR_STALE_S,
} from "@/lib/format";
import { RADAR_COLOR_SCHEME } from "@/lib/maplayers";

const PLANE = "M24 2 L27 12 L27 22 L44 32 L44 36 L27 30 L26 40 L32 44 L32 47 L24 45 L16 47 L16 44 L22 40 L21 30 L4 36 L4 32 L21 22 L21 12 Z";
const ALT_MAX = ALT_RAMP[ALT_RAMP.length - 1][0];
const ALT_TICKS: [number, string][] = [[0, "0"], [10000, "10k ft"], [25000, "FL250"], [40000, "FL400+"]];

/** 지도 아이콘과 같은 모양의 작은 비행기 */
function Plane({ color, opacity = 1, halo, title }: { color: string; opacity?: number; halo?: string; title?: string }) {
  return (
    <svg viewBox="-4 -4 56 56" width="14" height="14" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className="shrink-0">
      {title ? <title>{title}</title> : null}
      <path d={PLANE} fill={color} fillOpacity={opacity} stroke={halo ?? "none"} strokeWidth={halo ? 4 : 0} strokeOpacity={opacity} />
    </svg>
  );
}

function Row({ swatch, children, wide }: { swatch: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return <li className="flex items-center gap-2 py-[1px]"><span className={`flex shrink-0 justify-center whitespace-nowrap ${wide ? "min-w-6" : "w-6"}`}>{swatch}</span><span>{children}</span></li>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-2 py-1.5">
      <h3 className="label mb-1 text-[9px]">{title}</h3>
      <ul className="space-y-[1px]">{children}</ul>
    </section>
  );
}

/**
 * 지도 범례(GAP-13): 지도가 실제로 쓰는 색·선 규칙(format.ts·maplayers.ts 의 같은 상수)만 보여 준다. 켜진 레이어의 항목만.
 * 레이더 색 값(dBZ)은 서버가 준 기상청 범례만 표시하고, RainViewer 색표의 값은 지어내지 않는다.
 */
export function MapLegend({ id }: { id: string }) {
  const layers = useUi((s) => s.layers);
  const radarSource = useUi((s) => s.radarSource);
  const kr = useServerData((d) => d.radarKr);
  const hasRv = useServerData((d) => (d.radar?.past.length ?? 0) > 0);
  const grad = `linear-gradient(90deg, ${ALT_RAMP.map(([ft, c]) => `${c} ${(ft / ALT_MAX) * 100}%`).join(", ")})`;
  return (
    <div id={id} className="panel max-h-full w-[264px] overflow-y-auto text-[11px] text-fg-2" data-testid="map-legend" role="region" aria-label="지도 범례">
      {layers.aircraft ? (
        <Section title="항공기 · 고도(아이콘 색)">
          <li className="pb-1">
            <div className="h-2 w-full" style={{ background: grad }} role="img" aria-label="고도 색 램프: 0 ft 녹색, 10,000 ft 파랑, FL250 하늘색, FL400 이상 흰색" />
            <div className="relative mt-0.5 h-3 text-[9px] text-fg-3 mono">
              {ALT_TICKS.map(([ft, l], i) => (
                <span key={l} className="absolute" style={i === 0 ? { left: 0 } : i === ALT_TICKS.length - 1 ? { right: 0 } : { left: `${(ft / ALT_MAX) * 100}%`, transform: "translateX(-50%)" }}>{l}</span>
              ))}
            </div>
          </li>
          <Row swatch={<Plane color={ALT_UNKNOWN_COLOR} />}>고도 모름</Row>
          <Row swatch={<Plane color="#ffffff" />}>선택한 항공기</Row>
          <Row swatch={<Plane color="#e5484d" halo="#ff0000" />}>비상 squawk 7500·7600·7700</Row>
          <Row swatch={<Plane color="#4c90f0" halo="#ffffff" />}>관측 위치(흰 외곽선)</Row>
          <Row swatch={<Plane color="#4c90f0" />}>추정 위치 · dead reckoning(외곽선 없음)</Row>
          <Row swatch={<Plane color="#4c90f0" opacity={0.4} />}>STALE — 수신 지연·외삽 상한(40%)</Row>
          <Row swatch={<Plane color="#4c90f0" opacity={0.7} />}>수신 경과 모름(70%)</Row>
        </Section>
      ) : null}
      {layers.tracks || layers.prediction ? (
        <Section title="항적 · 예측">
          {layers.tracks ? <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "transparent", borderImage: `${grad} 1` }} />}>항적(DB 2 h + 실시간) · 고도 색</Row> : null}
          {layers.prediction ? <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: "#b18cf5" }} />}>10분 예측 궤적 — 추정</Row> : null}
        </Section>
      ) : null}
      {layers.sigmet ? (
        <Section title="SIGMET · 위험 유형">
          <li className="grid grid-cols-2 gap-x-2 gap-y-[2px] pb-1">
            {HAZARD_LEGEND.map((h) => (
              <span key={h.codes} className="flex items-center gap-1.5"><span className="legend-sw" style={{ background: h.color, opacity: 0.85 }} /><span className="mono text-[10px]">{h.codes}</span></span>
            ))}
          </li>
          <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "#a3aab4", borderTopWidth: 1 }} />}>유효</Row>
          <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: "#a3aab4" }} />}>30분 안에 만료(점선)</Row>
          <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "#a3aab4", borderTopWidth: 3 }} />}>안에 항공기 있음(관측 알림)</Row>
        </Section>
      ) : null}
      {layers.airports ? (
        <Section title="공항 · 비행 카테고리(METAR, 줌 5.5+)">
          <li className="flex flex-wrap gap-x-3 gap-y-[2px] pb-1">
            {Object.entries(CAT_COLORS).map(([k, c]) => (
              <span key={k} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: c }} /><span className="mono text-[10px]">{k}</span></span>
            ))}
          </li>
          <Row swatch={<span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: CAT_UNKNOWN_COLOR }} />}>카테고리 판정 불가(—)</Row>
          <Row swatch={<span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: CAT_STALE_FILL, border: `1.5px solid ${CAT_STALE_STROKE}` }} />}>METAR 오래됨(&gt; {METAR_STALE_S / 3600} h) — 색 없음</Row>
        </Section>
      ) : null}
      {layers.radar ? (
        <Section title={radarSource === "kma" ? "레이더 · 기상청 HSR" : "레이더 · RainViewer"}>
          {radarSource === "kma" ? (
            kr?.available && kr.legend?.length ? <>
              <li className="flex flex-wrap gap-[2px] pb-1" aria-label="반사도(dBZ) 색">
                {kr.legend.map(([lo, c]) => <span key={lo} className="mono px-1 text-[10px]" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})`, color: "#000" }}>{lo}</span>)}
                <span className="text-[10px] text-fg-3">dBZ 이상</span>
              </li>
              <Row swatch={<span className="legend-sw" style={{ background: "rgba(90,90,90,0.5)" }} />}>관측 범위 안 · 에코 없음</Row>
              <Row swatch={<span className="legend-sw border border-line-2" />}>관측 범위 밖(투명) — 자료 없음</Row>
            </> : <li className="text-fg-3">기상청 레이더 사용 불가</li>
          ) : hasRv ? <>
            <Row swatch={<span className="legend-sw" style={{ background: "#5a5a5a", opacity: 0.8 }} />}>커버리지 밖(회색) — 레이더 자료 없음</Row>
            <Row swatch={<span className="legend-sw border border-line-2" />}>커버리지 안 · 에코 없음(투명)</Row>
            <li className="text-[10px] text-fg-3">에코 색은 RainViewer 색표 {RADAR_COLOR_SCHEME}(제공처 정의) · 줌 ≤ 7 해상도</li>
          </> : <li className="text-fg-3">레이더 프레임 없음</li>}
        </Section>
      ) : null}
      <Section title="표기">
        <Row wide swatch={<span className="badge est px-1 text-[9px]">추정</span>}>점선 테두리 = 추정·가정 값</Row>
        <Row swatch={<span className="mono text-fg">—</span>}>값 모름(채우지 않음)</Row>
      </Section>
    </div>
  );
}
