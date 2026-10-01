// README 그림 내보내기: node scripts/readme-images.mjs [--dry-run]   (저장소 루트에서는 make readme-images)
//
// 설명서 캡처(scripts/guide-screenshots.mjs 가 쓴 public/guide/<id>.<내용 해시>.webp · lib/guide-manifest.json)를 README 가 가리키는
// docs/images/<이름>.webp(해시 없는 고정 이름 — 설정 lib/readme-images.json 의 name → 설명서 그림 id)로 복사하고, 설정에 없는 docs/images 의
// 그림 파일(png · webp · jpg · gif · avif · svg)은 지운다 — 무엇을 썼고 무엇을 지웠는지 보고한다. 다른 파일은 건드리지 않는다.
// 하나라도 틀리면 아무것도 바꾸지 않고 모든 이유를 적고 멈춘다(종료 코드 1): manifest 에 없는 그림(찍지 않았거나 건너뜀) · 파일이 없거나 크기가 다름 ·
// WebP 가 아님 · fixture 스택 그림인데 설정 · README 대체 글이 밝히지 않음(또는 그 반대) · README 가 설정에 없는 그림을 가리킴 · 설정의 그림을 README 가 쓰지 않음.
// 순서: 설명서를 찍고(guide-screenshots — 실데이터 스택 8700 에서 --skip ops,logs, 운영 · 로그는 다시 찍을 때만 격리 fixture 스택 8701 에서 --only ops,logs --allow-fixture)
// → 이 스크립트 → README · docs/images 커밋(README 7절).
// 종료 코드: 0 = 내보냄(또는 --dry-run 계획), 1 = 거절, 2 = 인자 오류.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportReadmeImages, parseReadmeConfig } from "./readme-images-lib.mjs";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..", "..");
const USAGE = "사용법: node scripts/readme-images.mjs [--dry-run]";

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => a !== "--dry-run");
if (unknown.length) { console.error(`알 수 없는 인자 ${unknown.join(" ")}\n${USAGE}`); process.exit(2); }
const dryRun = argv.includes("--dry-run");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
let config;
try {
  const plan = readJson(join(WEB, "lib/guide-shots.json"));
  config = parseReadmeConfig(readJson(join(WEB, "lib/readme-images.json")), (plan.shots ?? []).map((s) => s.id));
} catch (e) { console.error(e.message); process.exit(1); }
let manifest = null;
try { manifest = readJson(join(WEB, "lib/guide-manifest.json")); } catch (e) { console.error(`설명서 캡처 결과(lib/guide-manifest.json)를 읽지 못함: ${e.message}`); process.exit(1); }
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

const out = exportReadmeImages({ root: ROOT, web: WEB, config, manifest, readme, dryRun });
if (out.problems.length) {
  console.error(`README 그림을 내보내지 않음 — 아무것도 바꾸지 않았다(${out.problems.length}건):`);
  for (const p of out.problems) console.error(`  - ${p}`);
  process.exit(1);
}

const kb = (b) => `${Math.max(1, Math.round(b / 1024)).toLocaleString("en-US")} KB`;
/** 캡처 시각(manifest 의 UTC ISO) → KST 벽시계(+09:00 고정 — 화면과 같은 규칙) */
const kst = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} KST` : "—";
};
console.log(`${dryRun ? "[--dry-run — 바꾸지 않음] " : ""}README 그림 ${out.copied.length}장: 설명서 캡처 → docs/images`);
for (const c of out.copied) {
  console.log(`  ${c.to.padEnd(28)} ← ${c.from}  ${kb(c.bytes).padStart(7)}  캡처 ${kst(c.captured_at)}${c.fixture ? "  [fixture 스택 — README 대체 글이 밝힘]" : ""}`);
  if (c.variant) console.log(`  ${"".padEnd(28)}   조건: ${c.variant}`);
}
console.log(`합계 ${kb(out.copied.reduce((s, c) => s + c.bytes, 0))}`);
if (out.removed.length) {
  console.log(`${dryRun ? "지울" : "지움"} ${out.removed.length}개(설정에 없는 그림 파일):`);
  for (const r of out.removed) console.log(`  ${r.file}  ${kb(r.bytes)}`);
} else console.log("지운 그림 없음");
if (!dryRun) console.log("다음: git add -A docs/images README.md && 커밋");
