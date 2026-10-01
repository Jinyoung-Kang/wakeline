// README 그림 내보내기(scripts/readme-images.mjs)의 본체 — 시험(tests/readme-images.test.ts)이 임시 폴더로 부른다. 의존성 없음.
//
// 설명서 캡처(scripts/guide-screenshots.mjs 가 쓴 apps/web/public/guide/<id>.<해시>.webp 와 lib/guide-manifest.json)를 README 가 가리키는
// docs/images/<이름>.webp(해시 없는 고정 이름)로 복사하고, 설정(lib/readme-images.json)에 없는 docs/images 의 그림 파일을 지운다.
// 먼저 모든 것을 확인하고, 하나라도 틀리면 아무것도 바꾸지 않는다(problems 에 모든 이유):
// - 설정의 그림이 manifest 에 없음(찍지 않았거나 건너뜀) · 파일이 없거나 크기가 manifest 와 다름 · WebP 가 아님 · 파일 이름이 캡처 모양이 아님
// - fixture 스택 그림(캡처 조건에 "fixture" — guide-capture-lib fixtureVariant)인데 설정에 fixture: true 가 없거나 README 의 대체 글이 "fixture" 를
//   말하지 않음. 거꾸로 설정은 fixture 인데 캡처 조건이 아니면(실데이터로 다시 찍음) README 캡션이 틀리므로 거절
// - README 가 설정에 없는 docs/images 파일을 가리킴(깨진 그림이 된다) · 설정의 그림을 README 가 쓰지 않음
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { FILE_RE, fixtureVariant } from "./guide-capture-lib.mjs";

/** README 가 가리키는 그림 폴더(저장소 루트 기준) */
export const README_IMAGE_DIR = "docs/images";
/** 설명서 캡처 폴더(web 기준) */
const GUIDE_DIR = "public/guide";
/** 지울 수 있는 그림 파일(이것 말고는 docs/images 에 있어도 건드리지 않는다) */
const IMAGE_RE = /\.(png|webp|jpe?g|gif|avif|svg)$/i;
/** 내보낸 이름: 영문 소문자 · 숫자 · - (경로 글자 없음) */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 설정 검증 — 문제를 모두 모아 한 번에 던진다. 돌려주는 값: { images: [{ name, shot, fixture }] } */
export function parseReadmeConfig(raw, planIds) {
  if (!isObj(raw) || raw.version !== 1) throw new Error("readme-images: version 1 이 아님");
  const list = Array.isArray(raw.images) ? raw.images : [];
  if (!list.length) throw new Error("readme-images: images 가 비어 있음");
  const errs = [];
  const names = new Set(), shots = new Set();
  const images = list.map((x, i) => {
    const at = `images[${i}]`;
    if (!isObj(x)) { errs.push(`${at}: 객체가 아님`); return null; }
    if (typeof x.name !== "string" || !NAME_RE.test(x.name)) errs.push(`${at}.name: 영문 소문자 · 숫자 · - 만(파일 이름이 된다)`);
    else if (names.has(x.name)) errs.push(`${at}.name: 중복 "${x.name}"`);
    else names.add(x.name);
    if (typeof x.shot !== "string" || !planIds.includes(x.shot)) errs.push(`${at}.shot: 설명서 계획(lib/guide-shots.json)에 없는 그림 "${String(x.shot)}"`);
    else if (shots.has(x.shot)) errs.push(`${at}.shot: 중복 "${x.shot}"`);
    else shots.add(x.shot);
    if (x.fixture !== undefined && typeof x.fixture !== "boolean") errs.push(`${at}.fixture: true/false`);
    return { name: x.name, shot: x.shot, fixture: x.fixture === true };
  });
  if (errs.length) throw new Error(`readme-images:\n${errs.join("\n")}`);
  return { images };
}

/** README 의 docs/images 참조 — 그림 문법(![대체 글](경로))이면 대체 글, 그 밖의 링크면 alt null */
export function readmeImageRefs(readme) {
  const out = [];
  const re = /(!?)\[([^\]]*)\]\(docs\/images\/([^)\s]+)\)|docs\/images\/([A-Za-z0-9._-]+)/g;
  for (const m of readme.matchAll(re)) {
    if (m[3] != null) out.push({ file: m[3], alt: m[1] === "!" ? m[2] : null });
    else out.push({ file: m[4], alt: null });
  }
  return out;
}

/** 지울 파일: 그림 파일이면서 이번에 쓰지 않는 것 */
export function staleImages(files, keep) {
  const k = new Set(keep);
  return files.filter((f) => IMAGE_RE.test(f) && !k.has(f));
}

/**
 * 내보내기 계획 확인 + (dryRun 이 아니고 문제가 없으면) 실행.
 * root = 저장소 루트, web = apps/web, config = parseReadmeConfig 결과, manifest = lib/guide-manifest.json 내용, readme = README.md 글.
 * 돌려주는 값: { problems, copied: [{ name, shot, from, to, bytes, captured_at, variant, fixture }], removed: [{ file, bytes }] } — 경로는 저장소 루트 기준.
 * problems 가 있으면 아무것도 바꾸지 않고 copied · removed 는 빈 목록.
 */
export function exportReadmeImages({ root, web, config, manifest, readme, dryRun = false }) {
  const problems = [];
  const webRel = web.startsWith(root) ? web.slice(root.length).replace(/^\/+/, "") : web;
  const shots = isObj(manifest) && manifest.version === 1 && isObj(manifest.shots) ? manifest.shots : null;
  if (!shots) problems.push("설명서 캡처 결과(lib/guide-manifest.json): version 1 · shots 가 아님");
  const refs = readmeImageRefs(readme);
  const plan = [];
  for (const img of config.images) {
    const m = shots?.[img.shot];
    const p = (t) => problems.push(`${img.name}: ${t}`);
    if (!shots) continue;
    if (!isObj(m)) { p(`설명서 그림 "${img.shot}" — manifest(lib/guide-manifest.json)에 없음: 찍지 않았거나 건너뜀(guide-screenshots 보고를 보고 다시 찍는다)`); continue; }
    const f = typeof m.file === "string" ? FILE_RE.exec(m.file) : null;
    if (!f || f[1] !== img.shot) { p(`manifest 의 파일 이름이 캡처 모양(<id>.<해시>.<형식>)이 아님: ${String(m.file)}`); continue; }
    if (f[3] !== "webp" || m.format !== "webp") { p(`${m.file} — WebP 가 아님(README 는 ${README_IMAGE_DIR}/${img.name}.webp 를 가리킨다)`); continue; }
    const from = join(web, GUIDE_DIR, m.file);
    if (!existsSync(from)) { p(`${webRel}/${GUIDE_DIR}/${m.file} 없음 — manifest 와 파일이 어긋남`); continue; }
    const size = statSync(from).size;
    if (size !== m.bytes) { p(`${webRel}/${GUIDE_DIR}/${m.file} 크기 ${size} B 가 manifest 의 ${m.bytes} B 와 다름`); continue; }
    const fixture = fixtureVariant(m.variant);
    if (fixture && !img.fixture) p(`fixture 스택 그림(캡처 조건: ${m.variant}) — 설정(lib/readme-images.json)에 fixture: true 를 두고 README 대체 글에 밝힌다`);
    if (!fixture && img.fixture) p(`설정은 fixture 라는데 캡처 조건이 fixture 가 아님(${m.variant ?? "조건 없음"}) — 실데이터로 다시 찍었으면 설정과 README 캡션을 고친다`);
    const mine = refs.filter((r) => r.file === `${img.name}.webp`);
    if (!mine.length) p(`README 가 쓰지 않음(${README_IMAGE_DIR}/${img.name}.webp) — README 에 넣거나 설정에서 뺀다`);
    if (img.fixture) for (const r of mine) if (!(r.alt != null && /fixture/i.test(r.alt))) p(`README 의 대체 글(${JSON.stringify(r.alt ?? "그림 문법이 아님")})이 fixture 스택 그림이라고 말하지 않음`);
    plan.push({ name: img.name, shot: img.shot, from: `${webRel}/${GUIDE_DIR}/${m.file}`, to: `${README_IMAGE_DIR}/${img.name}.webp`, bytes: m.bytes, captured_at: m.captured_at, variant: m.variant ?? null, fixture, src: from });
  }
  const known = new Set(config.images.map((i) => `${i.name}.webp`));
  for (const r of refs) if (!known.has(r.file)) problems.push(`README 가 ${README_IMAGE_DIR}/${r.file} 를 가리키지만 설정에 없음(lib/readme-images.json) — 내보내지 않는 그림이라 깨진다`);
  if (problems.length) return { problems, copied: [], removed: [] };

  const dir = join(root, README_IMAGE_DIR);
  const present = existsSync(dir) ? readdirSync(dir) : [];
  const removed = staleImages(present, [...known]).map((f) => ({ file: `${README_IMAGE_DIR}/${f}`, bytes: statSync(join(dir, f)).size }));
  const copied = plan.map((c) => ({ name: c.name, shot: c.shot, from: c.from, to: c.to, bytes: c.bytes, captured_at: c.captured_at, variant: c.variant, fixture: c.fixture }));
  if (dryRun) return { problems, copied, removed };
  mkdirSync(dir, { recursive: true });
  for (const c of plan) {
    // 쓰다 멈춰도 반쯤 쓴 그림이 남지 않게: 옆 이름으로 복사한 뒤 바꾼다
    const tmp = join(dir, `.${c.name}.webp.tmp`);
    copyFileSync(c.src, tmp);
    renameSync(tmp, join(dir, `${c.name}.webp`));
  }
  for (const r of removed) unlinkSync(join(root, r.file));
  return { problems, copied, removed };
}
