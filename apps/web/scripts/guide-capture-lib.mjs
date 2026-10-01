// 설명서 캡처(scripts/guide-screenshots.mjs)의 순수 부분 — 브라우저 · 파일 시스템 없이 시험한다(tests/guide-capture.test.ts).
// 형식 규칙은 페이지(lib/guide.ts)와 같다: 파일 이름 <id>.<sha-256 앞 10자>.<webp|png>, manifest version 1.
import { createHash } from "node:crypto";

/** 페이지의 GUIDE_FILE_RE 와 같은 모양(시험이 둘을 맞춰 본다) */
export const FILE_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([0-9a-f]{10})\.(webp|png)$/;
export const DEFAULT_QUALITY = 0.86;
/** 화면 코드의 조회 오류 표시(data-testid) — 이것이 보이는 화면은 싣지 않는다(tests/guide-selectors 가 화면 코드에 있는지 확인) */
export const ERROR_MARKS = ["error-note", "request-id", "replay-error", "aircraft-detail-error", "ship-detail-error", "ship-track-error", "search-error-aircraft", "search-error-ships", "ops-login-error", "logs-rid-error"];
/** 번호를 요소 가장자리에서 안쪽으로 들이는 거리(px) — 번호 칸이 요소 위에 걸쳐 보이게 */
const INSET = 12;
/** 번호 칸이 이미지 밖으로 잘리지 않게 % 를 이 안으로 */
const EDGE_MIN = 1.5, EDGE_MAX = 98.5;

export const USAGE =
  "사용법: node scripts/guide-screenshots.mjs <기준 주소(로컬 스택)> <자격 증명 파일> [--only id,…] [--out-dir 폴더] [--quality 0–1] [--allow-fixture]\n" +
  "  자격 증명 파일: JSON {\"username\":\"…\",\"password\":\"…\"} 또는 두 줄(username, password) — chmod 600 권장";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 자격 증명처럼 보이는 옵션 — 값을 인자로 받지 않는다(프로세스 목록 · 셸 기록에 남는다). 문구에 값을 넣지 않는다 */
const CRED_OPT = /^--?(pass(word)?|pw|pwd|user(name)?|login|token|secret|cred(ential)?s?|auth)(=|$)/i;

/** 명령행 인자 → 설정. 틀리면 Error(문구에 사용법) */
export function parseArgs(argv) {
  const pos = [];
  const out = { baseUrl: "", credFile: "", only: null, outDir: null, quality: DEFAULT_QUALITY, allowFixture: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CRED_OPT.test(a)) throw new Error(`자격 증명은 파일로만 받습니다 — 인자 값 · 환경 변수는 프로세스 목록과 셸 기록에 남습니다.\n${USAGE}`);
    if (a === "--only") { const v = argv[++i]; if (!v) throw new Error(`--only 뒤에 스크린샷 id 목록\n${USAGE}`); out.only = v.split(",").map((s) => s.trim()).filter(Boolean); }
    else if (a === "--out-dir") { const v = argv[++i]; if (!v) throw new Error(`--out-dir 뒤에 폴더\n${USAGE}`); out.outDir = v; }
    else if (a === "--quality") {
      const q = Number(argv[++i]);
      if (!(q > 0 && q <= 1)) throw new Error(`--quality 는 0보다 크고 1 이하(WebP 품질)\n${USAGE}`);
      out.quality = q;
    } else if (a === "--allow-fixture") out.allowFixture = true;
    else if (a.startsWith("-")) throw new Error(`알 수 없는 옵션 ${a.split("=")[0]}\n${USAGE}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error(USAGE);
  [out.baseUrl, out.credFile] = pos;
  return out;
}

/** 기준 주소: 로컬 스택만(로그인 정보를 보낸다) · 주소 안 사용자 정보 금지. 돌려주는 값은 origin(끝 "/" 없음) */
export function checkLocalBase(s) {
  let u;
  try { u = new URL(s); } catch { throw new Error(`기준 주소가 URL 이 아님: ${s}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`기준 주소는 http(s) 만: ${u.protocol}`);
  if (u.username || u.password) throw new Error("기준 주소에 사용자 정보(user:pw@)를 넣지 않습니다 — 자격 증명은 파일로");
  const h = u.hostname;
  if (!(h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost"))) throw new Error(`로컬 스택만 찍습니다(localhost · 127.0.0.1 · [::1]) — 받은 호스트 ${h}`);
  return u.origin;
}

/**
 * 실데이터 스택인가 — GET /api/v1/status 의 답(HTTP 상태, JSON 본문)으로 판단한다. 설명서에 지어낸 값(FIXTURE MODE)이 실리지 않게 하는 유일한 관문이다.
 * 상태 바의 FIXTURE MODE 배지는 구독 뒤 status 메시지가 와야 그려져(WS welcome 보다 늦다) 경합이 있고 상황판 화면에만 있어, 배지로 판단하지 않는다.
 * 확실히 실데이터(fixture_mode === false · collector_mode_known === true)일 때만 null, 그 밖(FIXTURE · 수집 모드 모름 · 형식 아님 · 응답 없음)은 멈출 이유.
 */
export function realDataVerdict(httpStatus, body) {
  if (!httpStatus) return "상태 조회(/api/v1/status) 응답 없음 — 수집 모드를 확인할 수 없음";
  if (httpStatus !== 200) return `상태 조회(/api/v1/status) HTTP ${httpStatus} — 수집 모드를 확인할 수 없음`;
  if (!isObj(body)) return "상태 응답이 객체가 아님 — 수집 모드를 확인할 수 없음";
  if (body.fixture_mode === true) return "FIXTURE MODE 스택(가짜 자료)";
  if (body.fixture_mode !== false) return "상태 응답에 fixture_mode(true/false)가 없음 — 수집 모드를 확인할 수 없음";
  if (body.collector_mode_known !== true) return "수집기 heartbeat 가 없어 수집 모드를 모름(collector_mode_known ≠ true)";
  return null;
}

/** --allow-fixture 로 찍을 때 캡처 조건 앞에 붙는 표시 — 둘 다 "fixture" 를 담는다(fixtureVariant 가 알아본다) */
const FIXTURE_NOTE = "fixture 스택(가짜 자료)";
const UNKNOWN_MODE_NOTE = "수집 모드 모름(fixture 허용으로 찍음)";

/**
 * 실데이터로 확인되지 않은 스택(--allow-fixture 로만 찍는다)의 표시 — 그 스택에서 찍은 모든 그림의 캡처 조건 맨 앞에 붙는다(설명서 · README 가 밝히게).
 * 확실히 실데이터(realDataVerdict 가 null)면 null, FIXTURE MODE 면 "fixture 스택(가짜 자료)", 그 밖(수집 모드 모름 · 응답 없음)은 모른다고 적는다.
 */
export function stackNote(httpStatus, body) {
  if (!realDataVerdict(httpStatus, body)) return null;
  return isObj(body) && body.fixture_mode === true ? FIXTURE_NOTE : UNKNOWN_MODE_NOTE;
}

/** 캡처 조건 앞에 스택 표시를 붙인다(" · " 로). 둘 다 없으면 null */
export function withStackNote(note, variant) {
  const parts = [note, variant].filter((x) => x != null && x !== "");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 이 캡처 조건이 실데이터가 아닌 스택의 그림인가 — "fixture" 가 들어 있으면(stackNote 의 두 표시 · 예전에 손으로 붙인 '격리 fixture 스택').
 * README 내보내기(scripts/readme-images.mjs)가 이것으로 fixture 그림을 알아보고, README 캡션이 밝히지 않으면 내보내지 않는다.
 */
export function fixtureVariant(variant) {
  return typeof variant === "string" && /fixture/i.test(variant);
}

/** 통계 화면의 패널 수(app/stats/page.tsx — FIR · 위험 유형 · 시간대별 항공기 · 알림) */
export const STATS_PANELS = 4;
const STATS_STATES = new Set(["loading", "ready", "empty", "error"]);

/**
 * 통계 화면을 찍을지 — 패널마다의 data-state(app/stats/page.tsx: loading · ready · empty · error)와 글자로 판단한다. panels = [{ id, state, text }].
 * 네 패널이 다 있지 않거나 모르는 상태면 건너뛴다(화면 모양을 추정하지 않는다), 받지 못한 패널이 있으면 그 패널 · 글자(앞 120자)와 함께 건너뛴다(실패 화면을 싣지 않는다),
 * 받는 중인 패널이 있으면 기다린다(wait). 모두 받았으면 찍는다(자료 · 빈 상태 문구 — 받은 응답의 실제 상태다).
 */
export function statsPanelsVerdict(panels) {
  if (panels.length !== STATS_PANELS) return { wait: false, skip: `통계 패널 ${panels.length}개(기대 ${STATS_PANELS}) — 화면 모양이 다름` };
  const odd = panels.find((p) => !STATS_STATES.has(p.state));
  if (odd) return { wait: false, skip: `통계 패널 ${odd.id} 의 상태가 ${odd.state} — 모르는 상태` };
  const bad = panels.find((p) => p.state === "error");
  if (bad) return { wait: false, skip: `통계 패널 ${bad.id} 조회 실패 — ${String(bad.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120)}` };
  return { wait: panels.some((p) => p.state === "loading"), skip: null };
}

/** 표 머리글 글자들에서 name 과 글자가 같은 열(공백은 하나로) — 없으면 -1(가릴 열을 못 찾으면 그 스크린샷을 싣지 않는다) */
export function findColumn(headers, name) {
  const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
  return headers.findIndex((h) => norm(h) === norm(name));
}

/** 페이지(lib/guide parseManifest)가 받는 캡처 조건 길이 상한 */
export const VARIANT_MAX = 120;

/** 캡처 조건 + 무엇을 가렸는지("… · 가림: 운영자 이름 · 메시지"). 둘 다 없으면 null. 상한을 넘으면 던진다(페이지가 조용히 버리지 않게 찍을 때 드러낸다) */
export function maskedVariant(variant, labels) {
  const parts = [variant, labels.length ? `가림: ${labels.join(" · ")}` : null].filter((x) => x != null && x !== "");
  const out = parts.length ? parts.join(" · ") : null;
  if (out != null && out.length > VARIANT_MAX) throw new Error(`캡처 조건이 ${VARIANT_MAX}자를 넘음(${out.length}자): ${out}`);
  return out;
}

/** 자격 증명 파일 내용 → { username, password }. 오류 문구에 값을 넣지 않는다(JSON.parse 의 문구도 원문 일부를 담을 수 있어 쓰지 않는다) */
export function parseCredentials(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("자격 증명 파일이 비어 있음");
  let username, password;
  if (text.trim().startsWith("{")) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error("자격 증명 파일: JSON 형식이 아님"); }
    if (!isObj(j) || typeof j.username !== "string" || typeof j.password !== "string") throw new Error("자격 증명 파일: JSON 에 문자열 username · password 가 필요");
    ({ username, password } = j);
  } else {
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length !== 2) throw new Error("자격 증명 파일: 두 줄(username, password) 또는 JSON 이어야 함");
    username = lines[0].trim();
    password = lines[1];
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) throw new Error("자격 증명 파일: username 형식이 아님(영문 · 숫자 · _ . - 1–64자)");
  if (password.length < 8 || password.length > 1024) throw new Error("자격 증명 파일: password 는 8–1024자");
  return { username, password };
}

/** 파일 권한(stat.mode)이 그룹 · 다른 사용자에게 열려 있으면 경고 문구 */
export function credentialFileWarning(mode) {
  if ((mode & 0o077) === 0) return null;
  return `경고: 자격 증명 파일 권한 ${(mode & 0o777).toString(8).padStart(4, "0")} — 다른 사용자도 읽을 수 있습니다. chmod 600 권장`;
}

/**
 * 요소 사각형(getBoundingClientRect) → 번호 위치(이미지 폭 · 높이의 %, 0.1 단위).
 * 화면에 보이는 부분만 쓰고(잘린 요소는 보이는 부분 기준), 가장자리에서 INSET 만큼 안쪽. 보이지 않으면 null — 위치를 지어내지 않는다.
 */
export function anchorPoint(rect, anchor, vp) {
  if (!rect) return null;
  const l = Math.max(0, rect.left), t = Math.max(0, rect.top);
  const r = Math.min(vp.width, rect.left + rect.width), b = Math.min(vp.height, rect.top + rect.height);
  const w = r - l, h = b - t;
  if (!(w > 0 && h > 0)) return null;
  const dx = Math.min(INSET, w / 2), dy = Math.min(INSET, h / 2);
  const X = { l: l + dx, c: (l + r) / 2, r: r - dx }, Y = { t: t + dy, c: (t + b) / 2, b: b - dy };
  const pick = { tl: ["l", "t"], tr: ["r", "t"], bl: ["l", "b"], br: ["r", "b"], c: ["c", "c"], l: ["l", "c"], r: ["r", "c"], t: ["c", "t"], b: ["c", "b"] }[anchor];
  if (!pick) throw new Error(`anchor ${anchor}`);
  const pct = (v, size) => Math.min(EDGE_MAX, Math.max(EDGE_MIN, Math.round((v / size) * 1000) / 10));
  return { x: pct(X[pick[0]], vp.width), y: pct(Y[pick[1]], vp.height) };
}

/** 내용 해시 파일 이름 — 내용이 같으면 이름도 같다(다시 찍어도 바뀌지 않았으면 캐시가 그대로) */
export function hashedName(id, bytes, ext) {
  return `${id}.${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.${ext}`;
}

/** 결과 합치기: 이번에 찍은 것은 바꾸고, 못 찍은 것은 이전 결과를 두고(더 오래된 실제 화면), 계획에 없는 것은 뺀다. 계획 순서로 */
export function mergeManifest(prev, captured, planIds) {
  const before = isObj(prev) && prev.version === 1 && isObj(prev.shots) ? prev.shots : {};
  const shots = {};
  for (const id of planIds) {
    if (captured[id]) shots[id] = captured[id];
    else if (isObj(before[id])) shots[id] = before[id];
  }
  return { version: 1, shots };
}

/** 지울 파일: 캡처 이름 모양이면서 결과가 더 가리키지 않는 것만(다른 파일은 절대 건드리지 않는다) */
export function staleFiles(files, manifest) {
  const keep = new Set(Object.values(manifest.shots).map((m) => m.file));
  return files.filter((f) => FILE_RE.test(f) && !keep.has(f));
}

const kb = (b) => `${Math.round(b / 1024).toLocaleString("en-US")} KB`;

/** 크기 보고: 스크린샷마다 형식 · 저장 크기 · PNG 크기 · 비율 · 보인 번호 수, 합계, 건너뛴 것과 이유 */
export function sizeReport(rows, skipped = []) {
  const head = `${"shot".padEnd(10)} ${"fmt".padEnd(5)} ${"saved".padStart(9)} ${"png".padStart(9)} ${"ratio".padStart(6)}  callouts  condition`;
  const lines = rows.map((r) => `${r.id.padEnd(10)} ${r.format.padEnd(5)} ${kb(r.bytes).padStart(9)} ${kb(r.pngBytes).padStart(9)} ${`${Math.round((r.bytes / r.pngBytes) * 100)}%`.padStart(6)}  ${`${r.callouts[0]}/${r.callouts[1]}`.padEnd(8)}  ${r.variant ?? ""}`);
  const saved = rows.reduce((s, r) => s + r.bytes, 0), png = rows.reduce((s, r) => s + r.pngBytes, 0);
  const total = `${"합계".padEnd(10)} ${"".padEnd(5)} ${kb(saved).padStart(9)} ${kb(png).padStart(9)} ${png ? `${Math.round((saved / png) * 100)}%`.padStart(6) : ""}  (${rows.length}장)`;
  return [head, ...lines, total, ...skipped.map((s) => `${s.id} — 건너뜀: ${s.reason}`)].join("\n");
}
