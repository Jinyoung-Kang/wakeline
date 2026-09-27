/**
 * 항공기 검색(GAP-12) 순수 로직 — GET /api/v1/aircraft/search?q= (hex·호출부호·등록번호 접두사, ≤ 20건).
 * 응답은 두 종류가 섞인다: 현재 스냅샷의 항공기(위치 있음 = 실시간), DB 의 과거 기록(hex·registration·type_code·last_seen, 위치 없음).
 * 없는 값은 null 로 두고 화면은 "—"(채우지 않는다).
 */
export interface SearchHit {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type_code: string | null;
  alt_ft: number | null;
  /** null = 모름 */
  on_ground: boolean | null;
  lat: number | null;
  lon: number | null;
  /** 현재 스냅샷에 있어 위치를 안다 */
  live: boolean;
  last_seen: string | null;
  provider: string | null;
}

/** 서버 검사(2..10자)와 같은 규칙 + 허용 문자만. 공백은 지운다. 쓸 수 없으면 null. */
export function normalizeQuery(raw: string): string | null {
  const q = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9-]{2,10}$/.test(q) ? q : null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseSearchResponse(body: unknown, max = 20): SearchHit[] {
  const items = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const hex = str(r.hex)?.toLowerCase();
    if (!hex || !/^[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue; // 실시간 항목이 먼저 오므로 같은 hex 의 DB 항목은 버린다
    seen.add(hex);
    const lat = num(r.lat), lon = num(r.lon);
    const live = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    out.push({
      hex,
      callsign: str(r.callsign),
      registration: str(r.registration),
      type_code: str(r.type_code),
      alt_ft: num(r.alt_ft),
      on_ground: typeof r.on_ground === "boolean" ? r.on_ground : null,
      lat: live ? lat : null,
      lon: live ? lon : null,
      live,
      last_seen: str(r.last_seen) ?? str(r.seen_at),
      provider: str(r.provider),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 목록 키보드 이동: -1 = 선택 없음. 끝에서 처음으로 돈다. */
export function moveActive(cur: number, delta: 1 | -1, n: number): number {
  if (n <= 0) return -1;
  if (cur < 0) return delta > 0 ? 0 : n - 1;
  return (cur + delta + n) % n;
}

/** 입력 중인 요소에서는 "/" 단축키를 가로채지 않는다 */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof el !== "object") return false;
  const e = el as { tagName?: string; isContentEditable?: boolean };
  const tag = (e.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable === true;
}
