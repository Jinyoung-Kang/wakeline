"use client";
import { useServerData } from "@/lib/store";
import { useUi, type Layers } from "@/lib/ui-store";
import {
  ALT_RAMP, ALT_UNKNOWN_COLOR, CAT_COLORS, CAT_STALE_FILL, CAT_STALE_STROKE, CAT_UNKNOWN_COLOR, GND_COLOR, HAZARD_LEGEND, METAR_STALE_S,
} from "@/lib/format";
import { NODIR_PATH, PLANE_PATH, RADAR_COLOR_SCHEME } from "@/lib/maplayers";
import { HULL_COG_DASH, HULL_COG_INNER, HULL_COG_STROKE, HULL_PATH, SHIP_COVERAGE_COLOR, SHIP_GRID_STYLE, SHIP_NODIR_PATH } from "@/lib/ship-layers";
import { aisCoverageFeatures, SHIP_CATEGORIES, SHIP_CATEGORY_CODES, SHIP_CATEGORY_COLOR, SHIP_CATEGORY_LABEL, SHIP_STALE_S, SHIPS_RULE, SHIPS_RULE_TEXT } from "@/lib/ships";

const ALT_MAX = ALT_RAMP[ALT_RAMP.length - 1][0];
const ALT_TICKS: [number, string][] = [[0, "0"], [10000, "10k ft"], [25000, "FL250"], [40000, "FL400+"]];

/** 지도 아이콘과 같은 모양의 작은 비행기(nodir = 방위 모름 마름모) */
function Plane({ color, opacity = 1, halo, title, nodir }: { color: string; opacity?: number; halo?: string; title?: string; nodir?: boolean }) {
  return (
    <svg viewBox="-4 -4 56 56" width="14" height="14" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className="shrink-0">
      {title ? <title>{title}</title> : null}
      <path d={nodir ? NODIR_PATH : PLANE_PATH} fill={color} fillOpacity={opacity} stroke={halo ?? "none"} strokeWidth={halo ? 4 : 0} strokeOpacity={opacity} />
    </svg>
  );
}

/** 지도 선박 아이콘과 같은 모양(heading = 선체 · cog = 점선 외곽 + 작은 선체 · none = 원) */
function Hull({ color, mode = "heading", opacity = 1, title }: { color: string; mode?: "heading" | "cog" | "none"; opacity?: number; title?: string }) {
  return (
    <svg viewBox="-2 -2 52 52" width="14" height="14" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className="shrink-0">
      {title ? <title>{title}</title> : null}
      {mode === "heading" ? <path d={HULL_PATH} fill={color} fillOpacity={opacity} /> : null}
      {mode === "none" ? <path d={SHIP_NODIR_PATH} fill={color} fillOpacity={opacity} /> : null}
      {mode === "cog" ? <>
        <path d={HULL_PATH} fill="none" stroke={color} strokeWidth={HULL_COG_STROKE} strokeDasharray={HULL_COG_DASH.join(" ")} strokeOpacity={opacity} />
        <path d={HULL_PATH} fill={color} fillOpacity={opacity} transform={`translate(${HULL_COG_INNER.tx} ${HULL_COG_INNER.ty}) scale(${HULL_COG_INNER.scale})`} />
      </> : null}
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
  return <MapLegendView id={id} layers={layers} radarSource={radarSource} />;
}

/** 표시 부분(레이어·레이더 출처를 인자로 — 서버 렌더 시험용) */
export function MapLegendView({ id, layers, radarSource }: { id: string; layers: Layers; radarSource: "rainviewer" | "kma" }) {
  const kr = useServerData((d) => d.radarKr);
  const hasRv = useServerData((d) => (d.radar?.past.length ?? 0) > 0);
  // 경계선이 실제로 그려질 때만(전 해역 구독이면 그릴 경계가 없다)
  const hasCoverage = useServerData((d) => aisCoverageFeatures(d.ais?.coverage ?? null).features.length > 0);
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
          <Row swatch={<Plane color={GND_COLOR} />}>지상(GND · 공급자 on_ground) — 고도 색 아님</Row>
          <Row swatch={<Plane color="#4c90f0" nodir />}>방위 모름 — 방향 없는 마름모(북쪽으로 그리지 않음)</Row>
          <Row swatch={<Plane color="#ffffff" />}>선택한 항공기</Row>
          <Row swatch={<Plane color="#e5484d" halo="#ff0000" />}>비상 squawk 7500·7600·7700</Row>
          <Row swatch={<Plane color="#4c90f0" halo="#ffffff" />}>관측 위치(흰 외곽선)</Row>
          <Row swatch={<Plane color="#4c90f0" />}>추정 위치 · dead reckoning(외곽선 없음)</Row>
          <Row swatch={<Plane color="#4c90f0" opacity={0.4} />}>STALE — 수신 지연·외삽 상한(40%)</Row>
          <Row swatch={<Plane color="#4c90f0" opacity={0.7} />}>수신 경과 모름(70%)</Row>
        </Section>
      ) : null}
      {layers.ships ? (
        <Section title="선박 · 선종(아이콘 색, AIS)">
          <li className="grid grid-cols-2 gap-x-2 gap-y-[2px] pb-1">
            {SHIP_CATEGORIES.map((c) => (
              <span key={c} className="flex items-center gap-1.5" title={`코드 ${SHIP_CATEGORY_CODES[c]}`}><Hull color={SHIP_CATEGORY_COLOR[c]} /><span className="text-[10px]">{SHIP_CATEGORY_LABEL[c]}</span></span>
            ))}
          </li>
          <Row swatch={<Hull color="#c7ccd4" />}>선수방위(heading) 방향</Row>
          <Row swatch={<Hull color="#c7ccd4" mode="cog" />}>침로 기준 — 선수방위 없음(점선 외곽)</Row>
          <Row swatch={<Hull color="#c7ccd4" mode="none" />}>방향 모름 — 회전하지 않는 원</Row>
          <Row swatch={<Hull color="#ffffff" />}>선택한 선박</Row>
          <Row swatch={<Hull color="#c7ccd4" opacity={0.35} />}>STALE — {SHIP_STALE_S / 60}분 넘게 새 위치 없음(35%)</Row>
          <Row swatch={<span className="inline-block h-3 w-3 rounded-full!" style={{ background: SHIP_CATEGORY_COLOR.cargo, opacity: SHIP_GRID_STYLE.opacity, border: `${SHIP_GRID_STYLE.strokeWidth}px solid ${SHIP_GRID_STYLE.stroke}` }} />}>
            <span title={SHIPS_RULE_TEXT}>격자(줌 {SHIPS_RULE.lowZoom} 미만 · 화면 안 선박이 많을 때): 칸 선박 수 — 원 크기 = 수, 색 = 가장 많은 선종</span>
          </Row>
          {hasCoverage ? (
            <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: SHIP_COVERAGE_COLOR }} />}>
              <span data-testid="legend-ship-coverage" title="AIS 수집기가 구독하는 영역(운영 설정 ais_bboxes) — 점선 밖의 선박은 받지 않습니다">선박 수신 범위(운영 설정)</span>
            </Row>
          ) : null}
          {layers.tracks ? <>
            <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "#dbe4ee" }} />}>선박 항적(기록 · 60 s 에 1점 + 실시간)</Row>
            <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: "#8a929d" }} />}>공백 — AIS 끊김·15분 넘는 기록 없음(그 사이 위치 모름)</Row>
          </> : null}
        </Section>
      ) : null}
      {layers.tracks || layers.prediction ? (
        <Section title="항적 · 예측">
          {layers.tracks ? <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "transparent", borderImage: `${grad} 1` }} />}>항적(DB 2 h + 실시간) · 고도 색</Row> : null}
          {layers.prediction ? <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: "#b18cf5" }} />}>10분 예측 궤적 — 추정(지금 위치부터 10분)</Row> : null}
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
          <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dotted", borderTopColor: "#a3aab4" }} />}>발효 전(잔 점선·연한 채움) — 아직 판정 안 함</Row>
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
