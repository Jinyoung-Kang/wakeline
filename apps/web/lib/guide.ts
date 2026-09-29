/**
 * 설명서(/guide) 자료 모델 — 화면(app/guide · components/guide)과 캡처 스크립트(scripts/guide-screenshots.mjs)가 같은 계획을 쓴다.
 * - 목차(GUIDE_TOC): 절 id · 번호 · 제목의 유일한 원천. 화면의 절 제목과 목차 · 좁은 화면 선택 상자가 모두 여기서 나온다.
 * - 캡처 계획(guide-shots.json): 스크린샷마다 경로 · 대체 글 · 번호 설명(무엇을 가리키는지 CSS 선택자 포함). 틀리면 던진다(빌드 · 시험에서 드러나게).
 * - 캡처 결과(guide-manifest.json): 스크립트가 찍은 파일 이름(내용 해시) · 크기 · 캡처 시각 · 번호 위치(찍을 때 잰 요소 위치, %)를 쓴다.
 *   항목 단위로 검증해 틀린 항목은 버리고 이유를 남긴다 — 버린 · 없는 스크린샷은 화면에서 "스크린샷 준비 중" 자리표시가 된다(깨진 이미지를 보이지 않는다).
 * 번호 위치는 추정하지 않는다: 찍을 때 그 요소가 화면에 보였을 때만 기록하고, 없으면 번호 목록에 "이 스크린샷에는 보이지 않음"이라고 적는다.
 * 의존성 없음(lib/kst 만) — 서버 컴포넌트가 불러오고, 시험이 그대로 부른다.
 */
import planJson from "./guide-shots.json";
import manifestJson from "./guide-manifest.json";
import { isoKst } from "./kst";

// ---- 목차 ----

export interface TocItem { id: string; n: string; title: string; children?: TocItem[] }

export const GUIDE_TOC: readonly TocItem[] = [
  { id: "overview", n: "1", title: "무엇을 보여주나" },
  {
    id: "dashboard", n: "2", title: "상황판 사용법", children: [
      { id: "dashboard-layout", n: "2.1", title: "화면 구성" },
      { id: "dashboard-map", n: "2.2", title: "지도 조작" },
      { id: "dashboard-layers", n: "2.3", title: "레이어 · 선종 필터" },
      { id: "dashboard-search", n: "2.4", title: "통합 검색과 / 키" },
      { id: "dashboard-aircraft", n: "2.5", title: "항공기 카드 · 집중 추적" },
      { id: "dashboard-ship", n: "2.6", title: "선박 카드 · 항적" },
      { id: "dashboard-alerts", n: "2.7", title: "알림 · SIGMET · 근거 카드" },
      { id: "dashboard-radar", n: "2.8", title: "레이더 타임라인" },
      { id: "dashboard-legend", n: "2.9", title: "범례" },
      { id: "dashboard-status", n: "2.10", title: "상태 바 읽는 법" },
    ],
  },
  { id: "replay", n: "3", title: "재생" },
  { id: "stats", n: "4", title: "통계" },
  { id: "airport", n: "5", title: "공항" },
  {
    id: "ops", n: "6", title: "운영 · 로그 (운영자 전용)", children: [
      { id: "ops-login", n: "6.1", title: "로그인" },
      { id: "ops-dashboard", n: "6.2", title: "운영 화면 — 공급자 · 실행 · 파이프라인" },
      { id: "ops-logs", n: "6.3", title: "로그" },
    ],
  },
  { id: "time", n: "7", title: "시각 표기 (KST · UTC)" },
  { id: "rules", n: "8", title: "표시 규칙 — 모르는 값 · 추정 · 보고값" },
  { id: "shortcuts", n: "9", title: "키보드 단축키" },
];

/** 목차를 문서 순서의 한 줄로(절 → 그 아래 소절) */
export function flattenToc(items: readonly TocItem[] = GUIDE_TOC): TocItem[] {
  return items.flatMap((t) => [t, ...flattenToc(t.children ?? [])]);
}

/** 목차 항목(없으면 던진다 — 화면 코드가 모르는 id 를 쓰면 빌드에서 드러난다) */
export function tocItem(id: string): TocItem {
  const t = flattenToc().find((x) => x.id === id);
  if (!t) throw new Error(`guide: 목차에 없는 절 id "${id}"`);
  return t;
}

// ---- 키보드 단축키(코드에서 확인한 것만 — components/AircraftSearch · Shell · logs/LogsDashboard, MapLibre KeyboardHandler) ----

export interface Shortcut { keys: readonly string[]; where: string; action: string }

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Tab"], where: "모든 화면 — 첫 Tab", action: "‘본문으로 건너뛰기’ 링크(상황판은 ‘알림 목록으로 건너뛰기’도)" },
  { keys: ["/"], where: "상황판", action: "통합 검색 입력으로 초점 — 입력 칸 · 선택 상자에서 글자를 쓰는 중이 아닐 때" },
  { keys: ["↑", "↓"], where: "통합 검색", action: "결과 사이 이동(항공기 묶음 → 선박 표 순)" },
  { keys: ["Enter"], where: "통합 검색", action: "고른 결과 선택(고르지 않았으면 첫 결과)" },
  { keys: ["Esc"], where: "통합 검색", action: "결과 목록 닫기 — 이미 닫혀 있으면 검색어를 지우고 입력에서 나감" },
  { keys: ["Tab"], where: "통합 검색 결과", action: "선박 표 머리글(정렬 단추)로 이동" },
  { keys: ["←", "→", "↑", "↓"], where: "지도(지도에 초점이 있을 때)", action: "지도 이동" },
  { keys: ["="], where: "지도", action: "확대(숫자판 + 도 같음) — Shift 와 함께면 2단계(주 키보드의 + 는 Shift+=)" },
  { keys: ["-"], where: "지도", action: "축소(숫자판 - 도 같음) — Shift 와 함께면 2단계" },
  { keys: ["↑", "↓"], where: "로그 목록(표에 초점)", action: "항목 이동" },
  { keys: ["Enter"], where: "로그 목록", action: "고른 항목의 상세 열기" },
  { keys: ["c"], where: "로그 목록", action: "고른 항목(없으면 열린 상세)의 텍스트 복사" },
];

// ---- 캡처 계획 ----

export const ANCHORS = ["tl", "tr", "bl", "br", "c", "l", "r", "t", "b"] as const;
export type Anchor = (typeof ANCHORS)[number];
export interface GuideCallout { n: number; label: string; text: string; target: string; anchor: Anchor }
/**
 * 찍을 때 가리는 자리(설명서는 로그인 없이 누구나 본다 — 운영자 전용 화면의 운영 정보 · 브라우저가 보낸 글자를 싣지 않는다).
 * session_user: 로그인한 운영자 이름이 보이는 모든 자리. table + header: 그 표(CSS 선택자)에서 머리글 글자가 header 인 열의 모든 칸.
 * 캡처 스크립트는 가릴 자리를 찾지 못하면 그 스크린샷을 싣지 않는다(가리지 못한 화면을 내보내지 않는다).
 */
export interface GuideMask { label: string; session_user?: true; table?: string; header?: string }
export interface GuideShot { id: string; section: string; path: string; title: string; alt: string; callouts: GuideCallout[]; masks?: GuideMask[] }
export interface GuidePlan { version: 1; viewport: { width: number; height: number }; shots: GuideShot[] }

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 운영자 전용 화면(로그인 뒤에만 보인다) — 이 경로의 스크린샷은 운영자 이름 가림(session_user)이 있어야 계획이 통과한다 */
export const OPERATOR_PATHS: readonly string[] = ["/ops", "/logs"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10_000;

/** 캡처 계획 검증 — 문제를 모두 모아 한 번에 던진다(계획은 사람이 고치는 파일이라 틀린 곳을 전부 알려 준다) */
export function parsePlan(raw: unknown): GuidePlan {
  const errs: string[] = [];
  if (!isObj(raw) || raw.version !== 1) throw new Error("guide plan: version 1 이 아님");
  const vp = raw.viewport;
  if (!isObj(vp) || !posInt(vp.width) || !posInt(vp.height)) errs.push("viewport: width · height 는 양의 정수");
  const order = flattenToc().map((t) => t.id);
  const shots = Array.isArray(raw.shots) ? raw.shots : [];
  if (!shots.length) errs.push("shots: 비어 있음");
  const seen = new Set<string>();
  let lastAt = -1;
  shots.forEach((s: unknown, i) => {
    const at = `shots[${i}]`;
    if (!isObj(s)) { errs.push(`${at}: 객체가 아님`); return; }
    if (!str(s.id) || !ID_RE.test(s.id)) errs.push(`${at}.id: 영문 소문자 · 숫자 · - 만`);
    else if (seen.has(s.id)) errs.push(`${at}.id: 중복 "${s.id}"`);
    else seen.add(s.id);
    const secAt = typeof s.section === "string" ? order.indexOf(s.section) : -1;
    if (secAt < 0) errs.push(`${at}.section: 목차에 없는 절 "${String(s.section)}"`);
    else if (secAt < lastAt) errs.push(`${at}.section: 문서 순서가 아님(그림 번호가 뒤섞인다)`);
    else lastAt = secAt;
    if (!str(s.path) || !s.path.startsWith("/")) errs.push(`${at}.path: "/" 로 시작하는 경로`);
    if (!str(s.title)) errs.push(`${at}.title: 비어 있음`);
    if (!str(s.alt) || s.alt.trim().length < 20) errs.push(`${at}.alt: 대체 글은 20자 이상(무엇이 보이는지)`);
    const cs = Array.isArray(s.callouts) ? s.callouts : [];
    if (!cs.length) errs.push(`${at}.callouts: 비어 있음`);
    cs.forEach((c: unknown, j) => {
      const cat = `${at}.callouts[${j}]`;
      if (!isObj(c)) { errs.push(`${cat}: 객체가 아님`); return; }
      if (c.n !== j + 1) errs.push(`${cat}.n: 번호는 1부터 빠짐없이 차례로(기대 ${j + 1}, 받은 ${String(c.n)})`);
      if (!str(c.label)) errs.push(`${cat}.label: 비어 있음`);
      if (!str(c.text)) errs.push(`${cat}.text: 비어 있음`);
      if (!str(c.target)) errs.push(`${cat}.target: CSS 선택자가 비어 있음`);
      if (!(ANCHORS as readonly unknown[]).includes(c.anchor)) errs.push(`${cat}.anchor: ${ANCHORS.join("|")} 중 하나`);
    });
    const ms = s.masks === undefined ? [] : Array.isArray(s.masks) ? s.masks : null;
    if (ms == null) errs.push(`${at}.masks: 배열이 아님`);
    (ms ?? []).forEach((m: unknown, j) => {
      const mat = `${at}.masks[${j}]`;
      if (!isObj(m)) { errs.push(`${mat}: 객체가 아님`); return; }
      if (!str(m.label)) errs.push(`${mat}.label: 비어 있음(캡처 조건에 무엇을 가렸는지 적는다)`);
      const user = m.session_user === true, col = str(m.table) && str(m.header);
      if (user === col || (user && (m.table !== undefined || m.header !== undefined)) || (!user && m.session_user !== undefined)) {
        errs.push(`${mat}: session_user: true 이거나 table + header(CSS 선택자 · 머리글 글자) 중 하나만`);
      }
    });
    if (typeof s.path === "string" && OPERATOR_PATHS.includes(s.path) && !(ms ?? []).some((m: unknown) => isObj(m) && m.session_user === true)) {
      errs.push(`${at}.masks: 운영자 전용 화면(${s.path})은 운영자 이름 가림(session_user)이 있어야 함`);
    }
  });
  if (errs.length) throw new Error(`guide plan:\n${errs.join("\n")}`);
  return raw as unknown as GuidePlan;
}

// ---- 캡처 결과 ----

/** 캡처 파일 이름: <shot id>.<내용 sha-256 앞 10자>.<webp|png> — 내용이 바뀌면 이름이 바뀌어 오래 캐시해도 된다(next.config /guide) */
export const GUIDE_FILE_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([0-9a-f]{10})\.(webp|png)$/;
/** 공개 경로(public/guide) */
export const GUIDE_IMAGE_BASE = "/guide/";

export interface CalloutPos { n: number; x: number; y: number }
export interface ManifestShot {
  file: string; format: "webp" | "png"; width: number; height: number; bytes: number;
  /** 캡처 시각(ISO, UTC) */
  captured_at: string;
  /** 캡처 조건(예: 지도 위치 · 알림 범위) — 스크립트가 실제로 쓴 값 */
  variant: string | null;
  /** 찍을 때 화면에 보인 번호만(요소 위치, 이미지 폭 · 높이의 %) */
  callouts: CalloutPos[];
}
export interface GuideManifest { version: 1; shots: Record<string, ManifestShot> }

const pct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/** 캡처 결과 검증 — 틀린 항목(또는 번호 하나)만 버리고 이유를 모은다. 커밋된 결과는 시험이 버린 것 없음을 확인한다 */
export function parseManifest(raw: unknown, plan: GuidePlan): { manifest: GuideManifest; dropped: string[] } {
  const dropped: string[] = [];
  const out: GuideManifest = { version: 1, shots: {} };
  if (raw == null) return { manifest: out, dropped };
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.shots)) {
    dropped.push("manifest: version 1 · shots 객체가 아님 — 전체를 버림");
    return { manifest: out, dropped };
  }
  for (const [id, m] of Object.entries(raw.shots)) {
    const shot = plan.shots.find((s) => s.id === id);
    if (!shot) { dropped.push(`${id}: 계획에 없는 스크린샷`); continue; }
    if (!isObj(m)) { dropped.push(`${id}: 객체가 아님`); continue; }
    const f = typeof m.file === "string" ? GUIDE_FILE_RE.exec(m.file) : null;
    if (!f || f[1] !== id || f[3] !== m.format) { dropped.push(`${id}: file 이름이 "<id>.<해시 10자>.<format>" 이 아님 (${String(m.file)})`); continue; }
    if (!posInt(m.width) || !posInt(m.height)) { dropped.push(`${id}: width · height`); continue; }
    if (typeof m.bytes !== "number" || !Number.isInteger(m.bytes) || m.bytes <= 0) { dropped.push(`${id}: bytes`); continue; }
    if (typeof m.captured_at !== "string" || !Number.isFinite(Date.parse(m.captured_at))) { dropped.push(`${id}: captured_at`); continue; }
    const variant = typeof m.variant === "string" && m.variant.length <= 120 ? m.variant : null;
    if (m.variant != null && variant == null) dropped.push(`${id}: variant(캡처 조건)가 120자 이하 문자열이 아님 — 조건 없이 보인다`);
    const callouts: CalloutPos[] = [];
    for (const c of Array.isArray(m.callouts) ? m.callouts : []) {
      const ok = isObj(c) && shot.callouts.some((x) => x.n === c.n) && pct(c.x) && pct(c.y) && !callouts.some((x) => x.n === c.n);
      if (ok) callouts.push({ n: c.n as number, x: c.x as number, y: c.y as number });
      else dropped.push(`${id}: 번호 위치를 버림 ${JSON.stringify(c)}`);
    }
    out.shots[id] = { file: m.file as string, format: m.format as "webp" | "png", width: m.width, height: m.height, bytes: m.bytes, captured_at: m.captured_at, variant, callouts };
  }
  return { manifest: out, dropped };
}

export type ShotView =
  | { kind: "image"; src: string; width: number; height: number; format: "webp" | "png"; bytes: number; capturedAt: string; variant: string | null; markers: CalloutPos[] }
  | { kind: "placeholder"; width: number; height: number };

/** 한 스크린샷을 어떻게 그릴지 — 결과가 없으면 계획 크기의 자리표시(자리를 같게 잡아 레이아웃이 밀리지 않는다) */
export function shotView(shot: GuideShot, manifest: GuideManifest, viewport: { width: number; height: number } = PLAN.viewport): ShotView {
  const m = manifest.shots[shot.id];
  if (!m) return { kind: "placeholder", width: viewport.width, height: viewport.height };
  const markers = [...m.callouts].sort((a, b) => a.n - b.n);
  return { kind: "image", src: `${GUIDE_IMAGE_BASE}${m.file}`, width: m.width, height: m.height, format: m.format, bytes: m.bytes, capturedAt: m.captured_at, variant: m.variant, markers };
}

// ---- 시각 예(KST 를 먼저, UTC 를 함께) ----

/**
 * 한 순간 → KST · UTC 벽시계 "YYYY-MM-DD HH:MM:SS" 두 개. 설명서의 예와 캡처 시각에 쓴다(시각 표기 규칙: KST 기본 + UTC 병기).
 * 읽을 수 없으면 null(지어내지 않는다).
 */
export function dualTime(v: string | number | null | undefined): { kst: string; utc: string } | null {
  const k = isoKst(v);
  if (k == null || v == null) return null;
  const u = new Date(v).toISOString(); // isoKst 가 읽은 값이라 유효 — 같은 순간의 UTC ISO
  return { kst: `${k.slice(0, 10)} ${k.slice(11, 19)}`, utc: `${u.slice(0, 10)} ${u.slice(11, 19)}` };
}

/**
 * 발표 원문(METAR · TAF)의 시각 토큰 "DDHHMMZ"(UTC — 발표된 그대로의 모양). 설명서 7장의 예에서 원문 글자와 KST 를 나란히 보이는 데만 쓴다.
 * 읽을 수 없으면 null
 */
export function metarTimeToken(v: string | number | null | undefined): string | null {
  const d = dualTime(v);
  if (!d) return null;
  return d.utc.slice(8, 10) + d.utc.slice(11, 13) + d.utc.slice(14, 16) + "Z";
}

/** KST 벽시계 "HH:MM"(뒤의 " KST" 는 있어도 됨) → "HH:MM UTC" — UTC 날짜가 전날이면 "(전날)". 형식이 아니면 null */
export function kstClockToUtc(kst: string): string | null {
  const m = /^(\d\d):(\d\d)(?: KST)?$/.exec(kst.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const min = Number(m[1]) * 60 + Number(m[2]) - 9 * 60;
  const wrapped = (min + 1440) % 1440;
  const hm = `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  return `${hm} UTC${min < 0 ? "(전날)" : ""}`;
}

// ---- 이 빌드의 계획 · 결과 ----

export const PLAN: GuidePlan = parsePlan(planJson);
const parsed = parseManifest(manifestJson, PLAN);
export const MANIFEST: GuideManifest = parsed.manifest;
/** 커밋된 결과에서 버린 항목(있으면 화면 머리에 적는다 — 조용히 자리표시로 바꾸지 않게) */
export const MANIFEST_DROPPED: readonly string[] = parsed.dropped;
