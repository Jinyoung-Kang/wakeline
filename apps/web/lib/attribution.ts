/**
 * 데이터 출처 표기(FR-20 · NFR-15 "상시 노출") — 지도 위 크레딧과 하단 출처 줄이 이 한 목록을 쓴다.
 * 어느 화면 폭에서도 잘리지 않도록 하단 줄은 줄바꿈을 허용한다(가로 스크롤 영역에 두지 않는다).
 * 링크 주소는 collector 가 실제로 호출하는 서비스(providers/*.py)의 공개 홈페이지다. UN/LOCODE 는 api 가 담아 쓰는 자료(tools/gen_unlocode.py)의 원천(UNECE)이다.
 */
export interface Credit {
  /** 역할(무엇을 받는가) */
  role: string;
  label: string;
  href: string;
  /** 라이선스·조건 표기(있을 때만) */
  license?: { label: string; href: string };
  /** 괄호 안 짧은 설명(링크 아님) — 예: 선박 자료 종류 "AIS" */
  note?: string;
}

export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/";

export const CREDITS: Credit[] = [
  { role: "Aircraft", label: "adsb.lol", href: "https://adsb.lol", license: { label: "ODbL", href: ODBL_URL } },
  { role: "Aircraft", label: "adsb.fi", href: "https://adsb.fi" },
  { role: "Aircraft", label: "OpenSky Network", href: "https://opensky-network.org" },
  { role: "SIGMET · METAR · TAF", label: "AviationWeather.gov", href: "https://aviationweather.gov" },
  { role: "Ships", label: "aisstream.io", href: "https://aisstream.io", note: "AIS" },
  // 계약 v4 §F: 노선(콜사인 기준 등록 노선 — 선택한 항공기만, 저장하지 않음) · 선박 목적지 풀이용 항구 코드
  { role: "노선", label: "adsbdb.com", href: "https://www.adsbdb.com", note: "flight route data © David Taylor · Jim Mason" },
  { role: "항구 코드", label: "UN/LOCODE", href: "https://unece.org/trade/uncefact/unlocode", note: "UNECE, datasets/un-locode ODC-PDDL" },
  { role: "Radar", label: "RainViewer", href: "https://www.rainviewer.com" },
  { role: "Radar (KR)", label: "기상청 API허브", href: "https://apihub.kma.go.kr" },
  { role: "Map", label: "OpenFreeMap", href: "https://openfreemap.org" },
  { role: "Map", label: "OpenMapTiles", href: "https://www.openmaptiles.org" },
  { role: "Map", label: "OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
];

/** 역할별로 묶은 출처(표시 순서 유지) */
export function creditGroups(credits: Credit[] = CREDITS): { role: string; items: Credit[] }[] {
  const out: { role: string; items: Credit[] }[] = [];
  for (const c of credits) {
    const g = out.find((x) => x.role === c.role);
    if (g) g.items.push(c); else out.push({ role: c.role, items: [c] });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * MapLibre AttributionControl 의 customAttribution(HTML 문자열). 위 고정 목록만으로 만들며 외부 입력은 들어가지 않는다(그래도 escape).
 * 배경지도 크레딧(OpenFreeMap·OpenMapTiles·OSM)은 스타일 소스가 이미 붙였으면(includeMap=false) 중복하지 않고,
 * 스타일에 없으면 여기서 붙인다(mapStyleHasBasemapCredit). `extra` 는 재생 화면처럼 앞에 붙일 설명.
 * 링크는 Tab 순서에서 뺀다(tabindex=-1, R-30) — 같은 링크가 모든 화면 하단(AttributionFooter)에 있어 키보드로는 거기서 연다.
 */
export function mapAttributionHtml(opts: { extra?: string; includeMap?: boolean } = {}): string {
  const { extra, includeMap = true } = opts;
  const link = (c: { label: string; href: string }) => `<a href="${esc(c.href)}" tabindex="-1" target="_blank" rel="noopener noreferrer">${esc(c.label)}</a>`;
  const parts = creditGroups(includeMap ? CREDITS : CREDITS.filter((c) => c.role !== "Map")).map((g) => `${esc(g.role)}: ${g.items.map((c) => link(c) + (c.license ? ` (${link(c.license)})` : "") + (c.note ? ` (${esc(c.note)})` : "")).join(" · ")}`);
  return (extra ? `${esc(extra)} · ` : "") + parts.join(" | ");
}

/** 순수 텍스트 버전(테스트·스크린리더 요약용) */
export function attributionText(): string {
  return creditGroups().map((g) => `${g.role}: ${g.items.map((c) => c.label + (c.license ? ` (${c.license.label})` : "") + (c.note ? ` (${c.note})` : "")).join(" · ")}`).join(" | ");
}

/** 스타일 소스의 attribution 문자열들에 배경지도 크레딧(OpenStreetMap·OpenMapTiles)이 모두 있는가 */
export function styleHasBasemapCredit(attributions: (string | undefined | null)[]): boolean {
  const all = attributions.filter(Boolean).join(" ");
  return /OpenStreetMap/i.test(all) && /OpenMapTiles/i.test(all);
}
