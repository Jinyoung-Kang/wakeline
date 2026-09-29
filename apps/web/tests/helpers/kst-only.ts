/**
 * KST 만 검사(계약 v5 §G20 — 사용자 결정 2026-09-30 "UTC 지우고 KST"): 화면 글자 · title · aria-label 에 UTC 가 남았는지.
 * 찾는 것: "UTC" 낱말, "…Z" 시각("23:41Z" · "23:41:14Z" · "00Z" 시 눈금 · "282330Z" 같은 원문 모양 토큰), ISO …Z("2026-09-28T23:41:14.906Z").
 * 원문(METAR · TAF · SIGMET 발표문 · 서버 로그 메시지 본문 · 수집기가 쓴 원본 레코드)은 발표 · 기록된 그대로라 뺀다 — 화면은 그 요소에 data-raw 를 단다
 * (DOM 검사 함수가 data-raw 요소의 아래를 건너뛴다). 글자만 넘기는 곳은 부르는 쪽이 원문을 빼고 넘긴다.
 */
import { existsSync } from "node:fs";
import type { HNode } from "./html-tree";
import { MiniElement } from "./mini-dom";

const LEAKS = [
  /\bUTC\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g, // 23:41Z · 23:41:14Z · 23:41:14.906Z
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, // ISO …Z
  /(?<![\w.:-])\d{2}(?:\d{2}(?:\d{2})?)?Z\b/g, // 00Z(시 눈금) · 2330Z · 282330Z(원문 모양 토큰)
];

/** 글자 안의 UTC 흔적(찾은 조각과 앞뒤 몇 글자). 없으면 [] */
export function utcLeaks(text: string): string[] {
  const out: string[] = [];
  for (const re of LEAKS) {
    for (const m of text.matchAll(re)) out.push(text.slice(Math.max(0, m.index! - 16), m.index! + m[0].length + 8));
  }
  return out;
}

const ATTRS = ["title", "aria-label", "placeholder", "alt"];

/**
 * 다른 레인(대시보드 UX)의 파일 글자 — 이 레인은 그 파일(상단 검색 상자 components/AircraftSearch.tsx)을 고치지 않았다(파일 나눔). 그 안의 설명 한 줄이
 * 아직 "KST · UTC(…Z)" 라고 쓰고, 그 레인도 고치지 않았다(리뷰 2026-09-30). 그래서 면제는 그 레인이 합쳐지기 전까지만이다: 그 레인이 새로 더하는
 * lib/statusbar.ts 가 있으면(합친 뒤) 비어, 화면 검사 · 소스 검사가 그 줄을 UTC 로 잡는다 — 합치는 사람이 "(마지막 수신·저장 시각은 KST · …)" 로 고친다.
 * 면제 중에는 쓰는 시험이 그 글자가 아직 있는지(toContain)도 본다.
 */
export const pendingOtherLane = (merged: boolean): string[] => (merged ? [] : ["(마지막 수신·저장 시각은 KST · UTC(…Z) ·"]);
/** 다른 레인(대시보드 UX)이 합쳐졌는가 — 그 레인이 새로 더하는 lib/statusbar.ts 가 있으면 */
export const OTHER_LANE_MERGED = existsSync(new URL("../../lib/statusbar.ts", import.meta.url));
export const OTHER_LANE_PENDING = pendingOtherLane(OTHER_LANE_MERGED);
/** 다른 레인의 글자를 뺀 html/글자 */
export const withoutOtherLane = (s: string) => OTHER_LANE_PENDING.reduce((x, p) => x.split(p).join(""), s);

/** renderToStaticMarkup 트리(tests/helpers/html-tree)의 보이는 글자 · title · aria-label 에서 — data-raw 요소 아래는 건너뛴다 */
export function htmlUtcLeaks(root: HNode): string[] {
  const out: string[] = [];
  const walk = (n: HNode) => {
    if (n.tag === "#text") { out.push(...utcLeaks(n.text)); return; }
    if ("data-raw" in n.attrs) return;
    for (const a of ATTRS) if (n.attrs[a]) out.push(...utcLeaks(n.attrs[a]).map((x) => `${a}: ${x}`));
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** 마운트한 최소 DOM(tests/helpers/mini-dom)의 보이는 글자 · title · aria-label 에서 — data-raw 요소 아래는 건너뛴다. ignore = 뺄 글자(다른 레인의 글) */
export function domUtcLeaks(root: MiniElement, ignore: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (n: MiniElement) => {
    if (n.hasAttribute("data-raw")) return;
    for (const a of ATTRS) { const v = n.getAttribute(a); if (v) out.push(...utcLeaks(v).map((x) => `${a}: ${x}`)); }
    for (const c of n.childNodes) {
      if (c instanceof MiniElement) walk(c);
      else out.push(...utcLeaks(ignore.reduce((x, p) => x.split(p).join(""), c.textContent)));
    }
  };
  walk(root);
  return out;
}
