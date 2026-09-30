// 첫 화면 JS 예산 검사(NFR-04 · ADR-026) — 빌드 결과만으로(스택 · 브라우저 없이) 계산한다. CI 의 web job 이 운영 빌드 뒤에 웹 이미지 안에서 돌린다.
//   npm run build && npm run check:first-js                  # 이 호스트의 Node 로(빠른 확인 — zlib 이 달라 바이트가 조금 다를 수 있다)
//   npm run build && npm run check:first-js -- --in-image    # 웹 이미지(Dockerfile 실행 단계의 고정 node 이미지)의 Node 로 — 예산의 기준(CI)
//   ... -- --in-image --image wakeline-web:local            # 이미 받은 다른 이미지의 Node 로(같은 기반 이미지일 때 — 받기 없이)
// 종료 코드 0 = 예산 안 · 1 = 넘음 · 2 = 빌드 결과를 읽지 못함 / docker 가 이미지를 받거나 띄우지 못함(통과로 읽지 않는다).
// 무엇을 세는지 · 바이트 단위는 scripts/first-screen-js-lib.mjs 머리말.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dockerExitCode, FIRST_SCREEN_JS_BUDGET, inImageArgs, parseCheckArgs, runCheck, webImageNode } from "./first-screen-js-lib.mjs";

const WEB = resolve(import.meta.dirname, "..");
let args;
try {
  args = parseCheckArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

if (args.inImage) {
  let image;
  try {
    image = args.image ?? webImageNode(readFileSync(join(WEB, "Dockerfile"), "utf8"));
  } catch (e) {
    console.error(`웹 이미지의 Node 를 정하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  console.log(`웹 이미지의 Node 로 잽니다: docker ${inImageArgs(WEB, image).join(" ")}`);
  const r = spawnSync("docker", inImageArgs(WEB, image), { stdio: "inherit" });
  if (r.error) {
    console.error(`docker 를 실행하지 못했습니다: ${r.error.message}`);
    process.exit(2);
  }
  const code = dockerExitCode(r.status, r.signal);
  if (code === 2 && r.status !== 2) console.error(`docker 가 검사를 끝내지 못했습니다(종료 ${r.status ?? r.signal}) — 이미지를 받거나 띄우지 못했는지 위 출력을 보세요`);
  process.exit(code);
}

let reference = null;
try { reference = webImageNode(readFileSync(join(WEB, "Dockerfile"), "utf8")); } catch { /* 표에 '읽지 못함'으로 적힌다 */ }
const r = runCheck(WEB, FIRST_SCREEN_JS_BUDGET, { image: process.env.FIRST_JS_IMAGE || null, reference });
if (r.out) console.log(r.out);
if (r.err) console.error(`\n${r.err}`);
process.exit(r.code);
