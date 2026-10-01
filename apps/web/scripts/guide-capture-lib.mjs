// 설명서 캡처(scripts/guide-screenshots.mjs)의 순수 부분 — 브라우저 · 파일 시스템 없이 시험한다(tests/guide-capture.test.ts).
// 형식 규칙은 페이지(lib/guide.ts)와 같다: 파일 이름 <id>.<sha-256 앞 10자>.<webp|png>, manifest version 1.
import { createHash } from "node:crypto";

/** 이 스크린샷을 건너뛴다(이유와 함께) — 다른 스크린샷은 계속. lib 함수(until · awaitReading · shootStable)도 던진다 */
export class Skip extends Error {}
/** 전체를 멈춘다(이번 결과를 버린다) */
export class Fatal extends Error {}

/** 실제 시계 — 기다리는 함수는 시계를 받는다(시험은 sleep 이 시각을 옮기는 가짜 시계를 넘긴다) */
export const REAL_CLOCK = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

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
  "사용법: node scripts/guide-screenshots.mjs <기준 주소(로컬 스택)> <자격 증명 파일> [--only id,… | --skip id,…] [--out-dir 폴더] [--quality 0–1] [--allow-fixture]\n" +
  "  자격 증명 파일: JSON {\"username\":\"…\",\"password\":\"…\"} 또는 두 줄(username, password) — chmod 600 권장";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 자격 증명처럼 보이는 옵션 — 값을 인자로 받지 않는다(프로세스 목록 · 셸 기록에 남는다). 문구에 값을 넣지 않는다 */
const CRED_OPT = /^--?(pass(word)?|pw|pwd|user(name)?|login|token|secret|cred(ential)?s?|auth)(=|$)/i;

/** 명령행 인자 → 설정. 틀리면 Error(문구에 사용법) */
export function parseArgs(argv) {
  const pos = [];
  const out = { baseUrl: "", credFile: "", only: null, skip: null, outDir: null, quality: DEFAULT_QUALITY, allowFixture: false };
  const ids = (opt, v) => {
    const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new Error(`${opt} 뒤에 스크린샷 id 목록\n${USAGE}`);
    return list;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CRED_OPT.test(a)) throw new Error(`자격 증명은 파일로만 받습니다 — 인자 값 · 환경 변수는 프로세스 목록과 셸 기록에 남습니다.\n${USAGE}`);
    if (a === "--only") out.only = ids(a, argv[++i]);
    else if (a === "--skip") out.skip = ids(a, argv[++i]);
    else if (a === "--out-dir") { const v = argv[++i]; if (!v) throw new Error(`--out-dir 뒤에 폴더\n${USAGE}`); out.outDir = v; }
    else if (a === "--quality") {
      const q = Number(argv[++i]);
      if (!(q > 0 && q <= 1)) throw new Error(`--quality 는 0보다 크고 1 이하(WebP 품질)\n${USAGE}`);
      out.quality = q;
    } else if (a === "--allow-fixture") out.allowFixture = true;
    else if (a.startsWith("-")) throw new Error(`알 수 없는 옵션 ${a.split("=")[0]}\n${USAGE}`);
    else pos.push(a);
  }
  if (out.only && out.skip) throw new Error(`--only 와 --skip 은 함께 쓰지 않습니다\n${USAGE}`);
  if (pos.length !== 2) throw new Error(USAGE);
  [out.baseUrl, out.credFile] = pos;
  return out;
}

/**
 * 이번에 찍을 스크린샷 id(계획 순서) — --only 는 그것만, --skip 은 그것을 빼고. 계획에 없는 id 나 남는 것이 없으면 Error(인자 오류).
 * --skip 은 README 내보내기 설정이 fixture 스택 그림으로 적은 운영 · 로그를 실데이터 스택에서 덮어 찍지 않게 쓴다(README 7절).
 */
export function selectShots(planIds, { only, skip }) {
  for (const [opt, list] of [["--only", only], ["--skip", skip]]) {
    const unknown = (list ?? []).filter((id) => !planIds.includes(id));
    if (unknown.length) throw new Error(`${opt}: 계획에 없는 스크린샷 ${unknown.join(", ")} (있는 것: ${planIds.join(", ")})`);
  }
  const out = planIds.filter((id) => (!only || only.includes(id)) && !(skip ?? []).includes(id));
  if (!out.length) throw new Error("찍을 스크린샷이 없음(--only · --skip 을 확인)");
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

/** 확인하기 전 스택 상태(checkStack 의 state) */
export const STACK_UNCHECKED = Object.freeze({ note: null, checked: false });

/** 두 번째 확인의 스택 표시가 첫 확인과 다른가(찍는 사이에 스택이 바뀜) — 다르면 멈출 이유, 같거나 첫 확인이면 null */
export function stackTransition(prev, next, checked) {
  if (!checked || prev === next) return null;
  return `찍는 사이에 스택 상태가 바뀜(${prev ?? "실데이터"} → ${next ?? "실데이터"}) — 캡처 조건이 그림과 어긋나지 않게 이번 결과를 버리고 멈춤`;
}

/**
 * 실데이터 스택인지 확인(찍기 전 · 다 찍은 뒤) — fetchStatus() 는 GET /api/v1/status 의 { code, body } 를 돌려준다(던지면 응답 없음 = code 0).
 * --allow-fixture 여도 늘 묻는다(표시를 정하려고). 실데이터가 아니면 Fatal(--allow-fixture 면 멈추지 않고 표시 — stackNote), 첫 확인과 표시가 다르면 Fatal.
 * state = 이전 결과(처음은 STACK_UNCHECKED) → 새 state { note, checked: true }. note 는 모든 캡처 조건 맨 앞에 붙는다(withStackNote).
 */
export async function checkStack({ fetchStatus, allowFixture, state, when }) {
  let code = 0, body = null;
  try { ({ code, body } = await fetchStatus()); } catch { /* 응답 없음 → code 0 */ }
  const why = realDataVerdict(code, body);
  if (why && !allowFixture) throw new Fatal(`${when}: ${why} — 가짜 자료가 설명서에 실리지 않게 이번 결과를 버리고 멈춤(실데이터 스택에서 다시 찍거나 --allow-fixture)`);
  const note = stackNote(code, body);
  const change = stackTransition(state.note, note, state.checked);
  if (change) throw new Fatal(`${when}: ${change}`);
  return { note, checked: true };
}

/**
 * 이 캡처 조건이 실데이터가 아닌 스택의 그림인가 — "fixture" 가 들어 있으면(stackNote 의 두 표시 · 예전에 손으로 붙인 '격리 fixture 스택').
 * README 내보내기(scripts/readme-images.mjs)가 이것으로 fixture 그림을 알아보고, README 캡션이 밝히지 않으면 내보내지 않는다.
 */
export function fixtureVariant(variant) {
  return typeof variant === "string" && /fixture/i.test(variant);
}

/**
 * 지도 칩(data-testid demand-map-chip)이 '핫 리전이 지금 조회되고 있다'고 말하는가 — lib/demand hotChip 의 active 글자("핫 리전 30초 갱신(반경 100 NM)" ·
 * 주기 · 반경을 서버가 보고하지 않으면 그 부분 없이)만. active 는 수집기가 그 칸의 조회에 성공해 발행한 뒤에만 쓰고(collector jobs/demand.py _run_hot — 받은
 * 항공기가 0 대여도 active), api 는 마지막 성공이 max(15 s, 주기 × 3) 안일 때만 active 로 보낸다(CollectorDemandStatus.activeAt). 그러니 이 칸의 핫 리전 조회가
 * 최근에 성공했다는 증명이지, 지도의 어느 항공기가 핫 리전으로 받은 것이라는 증명은 아니다. 대기 · 지연 · 오류 · 꺼짐 · 제한 · 관심 지역 안 · 집중 추적 칩은 아니다.
 * 글자 모양은 시험(tests/guide-capture.test.ts)이 hotChip 의 모든 상태와 견준다.
 */
const HOT_ACTIVE_RE = /^핫 리전(?: \d+(?:\.\d)?초)? 갱신(?:\(반경 \d+ NM\))?$/;
export function isHotActive(kind, text) {
  return kind === "hot" && typeof text === "string" && HOT_ACTIVE_RE.test(text.trim());
}

/** 상태 바 aircraft 칩의 값(lib/statusbar — String(수) 또는 모르면 "—") → 수. 수가 아니면 null(읽지 못한 값을 지어내지 않는다) */
export function chipCount(text) {
  const t = typeof text === "string" ? text.trim() : "";
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** 지도 경로("/#줌/위도/경도")의 위치 글자 */
const where = (path) => path.replace(/^\//, "");

/** 전세계 그림의 캡처 조건 — 지도 위치와 찍을 때 상태 바가 보인 항공기 수(구독 영역 안 — 화면이 날짜 변경선을 넘으면 그 위도 띠 전체) */
export function worldVariant(path, aircraft) {
  return `전세계 ${where(path)} · 상태 바 aircraft ${aircraft}(구독 영역 안)`;
}

/** 핫 리전 그림의 캡처 조건 — 지도 위치(도쿄 — 계획의 경로) · 찍을 때 지도 칩 글자 그대로 · 상태 바 항공기 수 */
export function hotVariant(path, chipText, aircraft) {
  return `도쿄 ${where(path)} · 지도 칩 ‘${chipText}’ · 상태 바 aircraft ${aircraft}`;
}

/**
 * 지도 화면에서 world · hot 의 판정 재료를 읽는 자리(화면 코드의 data-testid — StatusBar ChipView · MapChips DemandBadge).
 * mapProbeInPage 가 이것으로 읽고, 시험은 그 화면 코드의 실제 마크업(서버 렌더)으로 같은 함수를 부른다.
 */
export const MAP_PROBE = Object.freeze({
  health: Object.freeze({ testId: "global-lag-badge", attr: "data-health" }),
  chip: Object.freeze({ testId: "demand-map-chip", attr: "data-kind" }),
  count: Object.freeze({ testId: "aircraft-count", value: ".chip-v" }),
});

/**
 * 지도 화면에서 읽는다: world 칩의 상태(data-health) · 지도 칩의 종류(data-kind)와 글자 · 상태 바 aircraft 칩의 값 글자. 없으면 null — 판정은 worldReading · hotReading.
 * 브라우저 안에서 page.evaluate(mapProbeInPage, MAP_PROBE) 로 돈다 — 글자로 옮겨지므로 인자와 document 말고 바깥 이름을 쓰지 않는다.
 */
export function mapProbeInPage(p) {
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  const chip = q(p.chip.testId);
  return {
    health: q(p.health.testId)?.getAttribute(p.health.attr) ?? null,
    chip: chip ? { kind: chip.getAttribute(p.chip.attr), text: (chip.textContent ?? "").trim() } : null,
    count: q(p.count.testId)?.querySelector(p.count.value)?.textContent ?? null,
  };
}

/** 상태 바 aircraft 칩이 1 이상인가 — 아니면 건너뛸 이유(읽은 그대로 — 수가 아니면 —) */
function countSkip(n) {
  return n > 0 ? null : `상태 바 aircraft 수가 1 이상이 아님(${n ?? "—"})`;
}

/**
 * 전세계 보기를 찍을 수 있는가(probe = mapProbeInPage 의 값) — world 칩이 정상(data-health "ok": 전세계 피드가 있고 서버 · 브라우저 판정 모두 오래되지 않음)이고
 * aircraft 가 1 이상일 때만 { variant }(캡처 조건 — 읽은 수), 아니면 { skip }(이유). 관심 지역만 찍힌 '전세계' 그림을 싣지 않는다.
 */
export function worldReading(probe, path) {
  const health = probe?.health ?? null;
  if (health !== "ok") return { skip: `상태 바 world 칩이 정상이 아님(${health ?? "칩 없음"}) — 전세계 피드가 없거나 오래됨` };
  const n = chipCount(probe.count);
  const skip = countSkip(n);
  return skip ? { skip } : { variant: worldVariant(path, n) };
}

/**
 * 핫 리전 그림을 찍을 수 있는가 — 지도 칩이 핫 리전 '갱신'(isHotActive — 이 칸의 핫 리전 조회가 최근에 성공했다는 서버 보고)이고 aircraft 가 1 이상일 때만
 * { variant }(칩 글자 그대로 · 읽은 수), 아니면 { skip }(마지막 칩 종류 · 글자).
 */
export function hotReading(probe, path) {
  const c = probe?.chip ?? null;
  if (!isHotActive(c?.kind, c?.text)) return { skip: `지도 칩이 핫 리전 ‘갱신’이 아님 — ${c ? `${c.kind} ‘${c.text}’` : "칩 없음"}` };
  const n = chipCount(probe.count);
  const skip = countSkip(n);
  return skip ? { skip } : { variant: hotVariant(path, c.text.trim(), n) };
}

/**
 * fn 이 Skip 없이 돌아올 때까지 stepMs 마다 다시(상한 ms — clock 기준). 끝까지 Skip 이면 마지막 Skip 을 던진다. Skip 이 아닌 오류는 곧바로 던진다.
 */
export async function until(fn, ms, clock = REAL_CLOCK, stepMs = 1_000) {
  const end = clock.now() + ms;
  for (;;) {
    try { return await fn(); } catch (e) { if (!(e instanceof Skip) || clock.now() >= end) throw e; }
    await clock.sleep(stepMs);
  }
}

/**
 * 핫 리전 칩이 '갱신'이 되기를 기다리는 상한 — 새 칸의 첫 조회는 수집기 전체에서 30 s 에 2칸까지만 곧바로이고 나머지는 한 주기(30 s) 뒤,
 * 호출 여유가 모자라면 주기가 60 · 120 s 로 는다(collector jobs/demand.py HOT_NEW_BURST · HOT_LEVELS_S — 시험이 가장 긴 주기 이상인지 본다). api 는 수집기 상태를 10 s 마다 읽는다.
 */
export const HOT_WAIT_MS = 120_000;
/** world 칩이 정상이 되기를 기다리는 상한(전세계 피드는 연결 직후 status 메시지로 온다 — 고른 값) */
export const WORLD_WAIT_MS = 30_000;

/**
 * 화면 값으로 캡처 조건을 정하는 그림의 판정 · 기다림. settleMs = 찍을 수 있게 된 뒤 더 기다리는 시간:
 * world — 기호 · 레이더 타일 그리기, hot — WS 차분 한 주기(api ws-diff-interval-s 10 s)를 넘게(시험이 api 설정과 견준다) 그 사이 받은 차분까지 그린 뒤.
 */
export const READINGS = Object.freeze({
  world: Object.freeze({ decide: worldReading, limitMs: WORLD_WAIT_MS, settleMs: 6_000 }),
  hot: Object.freeze({ decide: hotReading, limitMs: HOT_WAIT_MS, settleMs: 12_000 }),
});

/**
 * 화면 값으로 캡처 조건을 정하는 그림(world · hot): probe() 가 읽은 값을 spec.decide 로 판정해 찍을 수 있을 때까지 기다리고(상한 spec.limitMs — 끝까지 아니면
 * 마지막 이유로 Skip), spec.settleMs 더 기다린 뒤 읽기 함수를 돌려준다 — 찍기 직전 · 직후에 그 함수로 다시 판정한다(shootStable). 아니게 됐으면 Skip.
 */
export async function awaitReading(spec, { probe, path, clock = REAL_CLOCK }) {
  const read = async () => {
    const r = spec.decide(await probe(), path);
    if (r.skip != null) throw new Skip(r.skip);
    return r.variant;
  };
  await until(read, spec.limitMs, clock);
  await clock.sleep(spec.settleMs);
  return read;
}

/** 화면 값을 캡처 조건에 적는 그림: 찍기 전후 두 번 읽은 값이 다르면 다시 찍는 횟수(WS 차분이 10 s 마다 와 값이 바뀔 수 있다) */
export const READ_TRIES = 3;

/** 찍기 전후에 읽은 값 → 같으면 true(이 그림을 싣는다), 다르면 false(다시 찍는다) — tries 번째도 다르면 Skip */
export function stableRead(before, after, attempt, tries = READ_TRIES) {
  if (after === before) return true;
  if (attempt >= tries) throw new Skip(`찍는 동안 화면 값이 바뀜(${tries}번 — 마지막 ${before} → ${after})`);
  return false;
}

/**
 * 찍기 — read 가 있으면(캡처 조건이 화면 값) 찍기 직전과 직후에 읽어 같을 때만 싣고, 다르면 다시 찍는다(stableRead). read 가 던지는 Skip 은 그대로 올린다.
 * read 가 없으면 한 번 찍는다. shoot() = 번호 위치 재기 · 스크린샷. 돌려주는 값 { shot, reading } — reading = 직후에 읽은 값(read 가 없으면 null).
 */
export async function shootStable(read, shoot, tries = READ_TRIES) {
  for (let attempt = 1; ; attempt++) {
    const before = read ? await read() : null;
    const shot = await shoot();
    if (!read) return { shot, reading: null };
    const after = await read();
    if (stableRead(before, after, attempt, tries)) return { shot, reading: after };
  }
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
