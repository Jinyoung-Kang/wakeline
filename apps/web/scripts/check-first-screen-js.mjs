// 첫 화면 JS 예산 검사(NFR-04 · ADR-026) — 빌드 결과만으로(스택 · 브라우저 없이) 계산한다. CI 의 web job 이 운영 빌드 뒤에 돌린다.
//   npm run build && npm run check:first-js     # 표 + 판정. 종료 코드 0 = 예산 안 · 1 = 넘음 · 2 = 빌드 결과를 읽지 못함
// 무엇을 세는지 · 바이트 단위는 scripts/first-screen-js-lib.mjs 머리말. 브라우저 측정(scripts/measure-first-screen-js.mjs)과 파일 · 바이트가 같다(PERF §10).
import { resolve } from "node:path";
import { runCheck } from "./first-screen-js-lib.mjs";

const r = runCheck(resolve(import.meta.dirname, ".."));
if (r.out) console.log(r.out);
if (r.err) console.error(`\n${r.err}`);
process.exit(r.code);
