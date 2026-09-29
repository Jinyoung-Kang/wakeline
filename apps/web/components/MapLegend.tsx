"use client";
import { KR_REF_MIN_SUPPORT, KR_REF_WINDOW_MIN } from "@/lib/kr-radar";
import { TRAFFIC_BINS, TRAFFIC_FILL_OPACITY, TRAFFIC_LEGEND_NOTE, TRAFFIC_ZERO_COLOR } from "@/lib/traffic-grid";
import { useServerData } from "@/lib/store";
import { saveShipCats } from "@/lib/prefs";
import { useUi, type Layers } from "@/lib/ui-store";
import {
  ALT_RAMP, ALT_UNKNOWN_COLOR, altM, CAT_COLORS, CAT_STALE_FILL, CAT_STALE_STROKE, CAT_UNKNOWN_COLOR, GND_COLOR, HAZARD_LEGEND, legendTextColor, METAR_STALE_S,
} from "@/lib/format";
import { NODIR_PATH, PLANE_PATH, RADAR_COLOR_SCHEME } from "@/lib/maplayers";
import { BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE, BASEMAP_COAST } from "@/lib/basemap";
import { HULL_COG_DASH, HULL_COG_INNER, HULL_COG_STROKE, HULL_PATH, SHIP_COVERAGE_COLOR, SHIP_GRID_STYLE, SHIP_NODIR_PATH, SHIP_SELECTED_STYLE, SHIP_TRACK_POINT_STYLE } from "@/lib/ship-layers";
import { aisCoverageFeatures, type ShipCategory, SHIP_CATEGORIES, SHIP_CATEGORY_CODES, SHIP_CATEGORY_COLOR, SHIP_CATEGORY_LABEL, SHIP_STALE_S, SHIPS_RULE, SHIPS_RULE_TEXT } from "@/lib/ships";

const ALT_MAX = ALT_RAMP[ALT_RAMP.length - 1][0];
/** 고도 램프 눈금(계약 v5 §A3): ft(FL) 과 m. 마지막 눈금은 "그 이상" */
export const ALT_TICKS: { at: number; ft: string; m: string }[] = [
  { at: 0, ft: "0 ft", m: altM(0) }, { at: 10000, ft: "10k ft", m: altM(10000) }, { at: 25000, ft: "FL250", m: altM(25000) }, { at: 40000, ft: "FL400+", m: `${altM(40000)}+` },
];

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

/**
 * 선종 필터(계약 v5 §B3): 범례의 선종 항목이 곧 켜고 끄는 단추다(aria-pressed). 켜진 수를 늘 적는다("선종 필터 9/11").
 * 점 모드는 지도 filter, 격자 모드는 칸의 선종별 수로 다시 센다(MapView). 설정은 이 브라우저에만(lib/prefs).
 */
function ShipCategoryToggles({ cats }: { cats: readonly ShipCategory[] }) {
  const toggle = useUi((s) => s.toggleShipCat);
  const setCats = useUi((s) => s.setShipCats);
  const on = new Set(cats);
  const save = () => saveShipCats(useUi.getState().shipCats);
  return (
    <li className="pb-1">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`mono text-[10px] ${on.size < SHIP_CATEGORIES.length ? "text-warn" : "text-fg-2"}`} data-testid="ship-cat-count">선종 필터 {on.size}/{SHIP_CATEGORIES.length}</span>
        <span className="text-[9px] text-fg-3">누르면 지도에서 켜고 끔</span>
        {on.size < SHIP_CATEGORIES.length ? (
          <button type="button" className="btn px-1.5 py-0 text-[9px]" onClick={() => { setCats(SHIP_CATEGORIES); save(); }} data-testid="ship-cats-all">모두 켜기</button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-x-1 gap-y-[2px]" role="group" aria-label="선종 필터">
        {SHIP_CATEGORIES.map((c) => {
          const pressed = on.has(c);
          return (
            <button key={c} type="button" aria-pressed={pressed} title={`코드 ${SHIP_CATEGORY_CODES[c]} — ${pressed ? "누르면 숨김" : "숨김 · 누르면 표시"}`}
              className={`flex items-center gap-1.5 border px-1 py-[1px] text-left ${pressed ? "border-transparent hover:border-line-2" : "border-line text-fg-3 hover:border-line-2"}`}
              onClick={() => { toggle(c); save(); }} data-testid={`ship-cat-${c}`}>
              <Hull color={SHIP_CATEGORY_COLOR[c]} opacity={pressed ? 1 : 0.3} />
              <span className={`text-[10px] ${pressed ? "" : "line-through"}`}>{SHIP_CATEGORY_LABEL[c]}</span>
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** "#rrggbb" → [r, g, b] (범례 글자색 고르기용) */
function hexRgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function Row({ swatch, children, wide }: { swatch: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return <li className="flex items-center gap-2 py-[1px]"><span className={`flex shrink-0 justify-center whitespace-nowrap ${wide ? "min-w-6" : "w-6"}`}>{swatch}</span><span>{children}</span></li>;
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="border-t border-line px-2 py-1.5" data-testid={testId}>
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
  const shipCats = useUi((s) => s.shipCats);
  return <MapLegendView id={id} layers={layers} radarSource={radarSource} shipCats={shipCats} />;
}

/** 표시 부분(레이어·레이더 출처·선종 필터를 인자로 — 서버 렌더 시험용) */
export function MapLegendView({ id, layers, radarSource, shipCats = SHIP_CATEGORIES }: { id: string; layers: Layers; radarSource: "rainviewer" | "kma"; shipCats?: readonly ShipCategory[] }) {
  const kr = useServerData((d) => d.radarKr);
  const hasRv = useServerData((d) => (d.radar?.past.length ?? 0) > 0);
  // 경계선이 실제로 그려질 때만(전 해역 구독이면 그릴 경계가 없다)
  const hasCoverage = useServerData((d) => aisCoverageFeatures(d.ais?.coverage ?? null).features.length > 0);
  const grad = `linear-gradient(90deg, ${ALT_RAMP.map(([ft, c]) => `${c} ${(ft / ALT_MAX) * 100}%`).join(", ")})`;
  return (
    <div id={id} className="panel max-h-full w-[264px] max-w-full overflow-y-auto text-[11px] text-fg-2" data-testid="map-legend" role="region" aria-label="지도 범례">
      {layers.aircraft ? (
        <Section title="항공기 · 고도(아이콘 색)">
          <li className="pb-1">
            <div className="h-2 w-full" style={{ background: grad }} role="img"
              aria-label={`고도 색 램프: 0 ft(0 m) 녹색, 10,000 ft(${altM(10000)}) 파랑, FL250(${altM(25000)}) 하늘색, FL400(${altM(40000)}) 이상 흰색`} />
            {/* 눈금 두 줄: ft(FL) 아래 m — 한 줄로 쓰면 이웃 눈금과 겹친다 */}
            <div className="relative mt-0.5 h-6 text-[9px] text-fg-3 mono" data-testid="legend-alt-ticks">
              {ALT_TICKS.map((t, i) => (
                <span key={t.ft} title={`${t.ft} · ${t.m}`} className={`absolute flex flex-col leading-tight ${i === 0 ? "items-start" : i === ALT_TICKS.length - 1 ? "items-end" : "items-center"}`}
                  style={i === 0 ? { left: 0 } : i === ALT_TICKS.length - 1 ? { right: 0 } : { left: `${(t.at / ALT_MAX) * 100}%`, transform: "translateX(-50%)" }}>
                  <span>{t.ft}</span><span className="text-fg-3/80">{t.m}</span>
                </span>
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
          <ShipCategoryToggles cats={shipCats} />
          <Row swatch={<Hull color="#c7ccd4" />}>선수방위(heading) 방향</Row>
          <Row swatch={<Hull color="#c7ccd4" mode="cog" />}>침로 기준 — 선수방위 없음(점선 외곽)</Row>
          <Row swatch={<Hull color="#c7ccd4" mode="none" />}>방향 모름 — 회전하지 않는 원</Row>
          <Row swatch={<span className="relative inline-flex h-4 w-4 items-center justify-center rounded-full!" style={{ border: `${SHIP_SELECTED_STYLE.ringWidth}px solid ${SHIP_SELECTED_STYLE.ringColor}` }}><Hull color="#ffffff" /></span>}>
            <span data-testid="legend-ship-selected">선택한 선박 — 흰 고리 + 이름(모르면 MMSI), 격자·선종 필터와 상관없이 표시</span>
          </Row>
          <Row swatch={<Hull color="#c7ccd4" opacity={0.35} />}>STALE — {SHIP_STALE_S / 60}분 넘게 새 위치 없음(35%)</Row>
          <Row swatch={<span className="inline-block h-3 w-3 rounded-full!" style={{ background: SHIP_CATEGORY_COLOR.cargo, opacity: SHIP_GRID_STYLE.opacity, border: `${SHIP_GRID_STYLE.strokeWidth}px solid ${SHIP_GRID_STYLE.stroke}` }} />}>
            <span title={SHIPS_RULE_TEXT}>격자(줌 {SHIPS_RULE.lowZoom} 미만 · 화면 안 선박이 많을 때): 칸 선박 수 — 원 크기 = 수, 색 = 가장 많은 선종(선종 필터가 있으면 켜진 선종만 셈)</span>
          </Row>
          {hasCoverage ? (
            <Row swatch={<span className="legend-line" style={{ borderTopStyle: "dashed", borderTopColor: SHIP_COVERAGE_COLOR }} />}>
              <span data-testid="legend-ship-coverage" title="AIS 수집기가 구독하는 영역(운영 설정 ais_bboxes) — 점선 밖의 선박은 받지 않습니다">선박 수신 범위(운영 설정)</span>
            </Row>
          ) : null}
          {layers.tracks ? <>
            <Row swatch={<span className="legend-line" style={{ borderTopStyle: "solid", borderTopColor: "#dbe4ee" }} />}>선박 항적(기록 · 60 s 에 1점 + 실시간) · 기간 6/12/24 h(선박 카드)</Row>
            <Row swatch={<span className="inline-block rounded-full!" style={{ width: SHIP_TRACK_POINT_STYLE.radius * 2, height: SHIP_TRACK_POINT_STYLE.radius * 2, background: SHIP_TRACK_POINT_STYLE.color }} />}>
              항적 점 — 마우스를 올리면 시각(KST)·속력·침로·항해 상태
            </Row>
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
        <Section title="공항 · 비행 카테고리(METAR, 줌 5.5+ 원 · 7+ 라벨)">
          <li className="flex flex-wrap gap-x-3 gap-y-[2px] pb-1">
            {Object.entries(CAT_COLORS).map(([k, c]) => (
              <span key={k} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: c }} /><span className="mono text-[10px]">{k}</span></span>
            ))}
          </li>
          <Row swatch={<span className="mono text-[9px] text-fg-2">ICAO</span>} wide>줌 7 이상: 라벨에 카테고리 글자(예: RKSI IFR)</Row>
          <Row swatch={<span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: CAT_UNKNOWN_COLOR }} />}>카테고리 판정 불가(—)</Row>
          <Row swatch={<span className="inline-block h-2.5 w-2.5 rounded-full!" style={{ background: CAT_STALE_FILL, border: `1.5px solid ${CAT_STALE_STROKE}` }} />}>
            <span data-testid="legend-airport-stale">METAR 오래됨(&gt; {METAR_STALE_S / 3600} h) — 속이 빈 회색 고리(카테고리 색 없음). 줌 7 아래에서는 라벨이 없어 원만 보인다</span>
          </Row>
        </Section>
      ) : null}
      {layers.traffic ? (
        <Section title="연안 교통량 · 격자별 선박 척수(KOMSA)">
          <li className="flex flex-wrap items-center gap-[2px] pb-1" role="img" aria-label={`척수 구간 색: ${TRAFFIC_BINS.map((b) => b.label).join(", ")}척 — 많을수록 밝은 주황`} data-testid="legend-traffic-scale">
            {TRAFFIC_BINS.map((b) => <span key={b.label} className="mono px-1 text-[10px]" style={{ background: b.color, color: legendTextColor(hexRgb(b.color)) }}>{b.label}</span>)}
            <span className="ml-1 text-[10px] text-fg-3">척(칸마다)</span>
          </li>
          <Row swatch={<span className="legend-sw" style={{ background: TRAFFIC_ZERO_COLOR, opacity: TRAFFIC_FILL_OPACITY }} />}>0척 — 공급자가 보고한 빈 칸</Row>
          <li className="pt-0.5 text-[10px] text-fg-2" data-testid="legend-traffic-note">{TRAFFIC_LEGEND_NOTE}</li>
          <li className="text-[10px] text-fg-3">색 구간은 표시용 선택 · 칸에 마우스를 올리면 격자 번호 · 척수 · 밀집도 % · 기준 시각(KST)</li>
        </Section>
      ) : null}
      {layers.radar ? (
        <Section title={radarSource === "kma" ? "레이더 · 기상청 HSR" : "레이더 · RainViewer"}>
          {radarSource === "kma" ? (
            kr?.available && kr.legend?.length ? <>
              <li className="flex flex-wrap gap-[2px] pb-1" aria-label="반사도(dBZ) 색">
                {kr.legend.map(([lo, c]) => <span key={lo} className="mono px-1 text-[10px]" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})`, color: legendTextColor(c) }}>{lo}</span>)}
                <span className="text-[10px] text-fg-3">dBZ 이상</span>
              </li>
              <Row swatch={<span className="legend-sw" style={{ background: "rgba(90,90,90,0.5)" }} />}>관측 범위 안 · 에코 없음</Row>
              <Row swatch={<span className="legend-sw border border-line-2" />}>관측 범위 밖(투명) — 자료 없음</Row>
              <Row wide swatch={<span className="mono text-[9px] text-fg-2">N/M</span>}>합성 N/M곳 — 프레임 헤더의 레이더 지점 수 / 기준(지난 {KR_REF_WINDOW_MIN}분 저장 프레임 중 최대, 수집기 선택값). 모르면 —</Row>
              <Row wide swatch={<span className="badge warn px-1 text-[9px]">일부</span>}>일부 합성(N &lt; M) — 기준보다 적은 지점만 합성된 프레임(실자료라 숨기지 않음). 수집기가 기한까지 다시 받기 대상으로 두어 지점이 늘면 바꾼다</Row>
              <Row wide swatch={<span className="inline-block h-3 w-1.5 bg-accent/70" />}>기준 도달(N = M) — 지난 {KR_REF_WINDOW_MIN}분 최대와 같음(기준에 닿은 프레임 {KR_REF_MIN_SUPPORT}개 이상일 때만). 완전한지는 모름 · 판정 — = 비교할 프레임 없음</Row>
            </> : <li className="text-fg-3">기상청 레이더 사용 불가</li>
          ) : hasRv ? <>
            <Row swatch={<span className="legend-sw" style={{ background: "#5a5a5a", opacity: 0.8 }} />}>커버리지 밖(회색) — 레이더 자료 없음</Row>
            <Row swatch={<span className="legend-sw border border-line-2" />}>커버리지 안 · 에코 없음(투명)</Row>
            <li className="text-[10px] text-fg-3">에코 색은 RainViewer 색표 {RADAR_COLOR_SCHEME}(제공처 정의) · 줌 ≤ 7 해상도</li>
          </> : <li className="text-fg-3">레이더 프레임 없음</li>}
        </Section>
      ) : null}
      {/* 바탕 지도 선(2026-09-30): 동해의 회색 원(섬 둘레)과 바다 위 회색 선이 무엇인지 — 타일 속성 admin_level 2 · maritime 1(해상 국경)을 확인했다 */}
      <Section title="바탕 지도 선(OpenFreeMap · OpenMapTiles)" testId="legend-basemap">
        <Row swatch={<span className="inline-block w-4" style={{ borderTop: `1.5px solid ${BASEMAP_BOUNDARY_COUNTRY}` }} />}>국경 — 육상 · 해상 국경(섬 둘레의 회색 원도 해상 국경, 예: 울릉도 · 독도)</Row>
        <Row swatch={<span className="inline-block w-4" style={{ borderTop: `1px solid ${BASEMAP_BOUNDARY_STATE}` }} />}>행정 경계(시 · 도 등)</Row>
        <Row swatch={<span className="inline-block w-4" style={{ borderTop: `1px solid ${BASEMAP_COAST}` }} />}>해안선(육지 쪽 1 px)</Row>
      </Section>
      <Section title="표기">
        <Row wide swatch={<span className="badge est px-1 text-[9px]">추정</span>}>점선 테두리 = 추정·가정 값</Row>
        <Row swatch={<span className="mono text-fg">—</span>}>값 모름(채우지 않음)</Row>
      </Section>
    </div>
  );
}
