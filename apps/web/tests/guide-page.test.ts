/**
 * 설명서 화면(/guide) — 서버 렌더 결과로 확인한다(정적 렌더 · 클라이언트 자바스크립트는 목차의 현재 위치 표시와 좁은 화면 선택 상자뿐).
 * - 목차(넓은 화면 목록 · 좁은 화면 선택 상자)의 앵커와 절 id 가 같다(순서까지).
 * - 스크린샷: 결과(manifest)가 있으면 <img>(대체 글 · width · height · loading=lazy · decoding=async), 없으면 "스크린샷 준비 중" 자리표시.
 * - 번호: 그림 위 번호(HTML 겹침 — 이미지에 굽지 않음)마다 같은 번호의 설명 항목이 있고, 설명 목록은 1..n. 찍을 때 보이지 않은 번호는 목록에 그렇다고 적는다.
 * - 시각이 나오는 예는 KST 와 UTC 를 함께 적는다. 출처는 하단 출처 줄과 같은 목록(lib/attribution)에서.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CREDITS } from "@/lib/attribution";
import { normalizeQuery, normalizeShipQuery } from "@/lib/search";
import { flattenToc, parseManifest, PLAN, type GuideManifest, type ManifestDrop } from "@/lib/guide";
import { PORT_CALL_AUTHORITIES, PORT_CALL_TITLE, PORT_CALL_WINDOW_DAYS } from "@/lib/portcalls";
import { RESOLUTION_STATE_TEXT, RESOLVE_EFFECT } from "@/lib/resolutions";
import { STORED_STATIC_LABEL, STORED_STATIC_TIME_LABEL } from "@/lib/ships";
import { fmtDual, fmtDualCompact, fmtUtcDayDual } from "@/lib/time";
import { TRAFFIC_LAYER_LABEL, TRAFFIC_LEGEND_NOTE } from "@/lib/traffic-grid";

const links: { href: string; prefetch?: boolean | null }[] = [];
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    links.push({ href, prefetch });
    return createElement("a", { href, ...rest }, children);
  },
}));

const { GuideView } = await import("@/components/guide/GuideView");
const GuidePage = (await import("@/app/guide/page")).default;

const EMPTY: GuideManifest = { version: 1, shots: {} };
/** 모든 스크린샷이 있는 결과 — 마지막 번호 하나는 "찍을 때 보이지 않음"으로 뺀다 */
const FULL: GuideManifest = parseManifest({
  version: 1,
  shots: Object.fromEntries(PLAN.shots.map((s, i) => [s.id, {
    file: `${s.id}.${(i + 10).toString(16).padStart(10, "0")}.webp`, format: "webp", width: 1440, height: 900, bytes: 90_000 + i,
    captured_at: "2026-09-29T05:22:11.000Z", variant: i === 0 ? "한반도 #6.3/36.1/127.9" : null,
    callouts: s.callouts.slice(0, -1).map((c) => ({ n: c.n, x: 10 + c.n, y: 20 + c.n })),
  }])),
}, PLAN).manifest;

const render = (manifest: GuideManifest, dropped: ManifestDrop[] = []) => renderToStaticMarkup(createElement(GuideView, { manifest, dropped }));
const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** figure 하나씩(중첩 figure 없음) */
const figures = (html: string) => [...html.matchAll(/<figure\b[\s\S]*?<\/figure>/g)].map((m) => m[0]);

describe("guide page structure", () => {
  it("the route renders the committed manifest; the document title is 설명서", async () => {
    const html = renderToStaticMarkup(createElement(GuidePage));
    expect(html).toContain("data-testid=\"guide\"");
    expect(figures(html)).toHaveLength(PLAN.shots.length);
    expect((await import("@/app/guide/page")).metadata?.title).toBe("설명서");
  });
  it("TOC anchors (list and narrow-screen select) match the section ids, in document order", () => {
    const html = render(EMPTY);
    const ids = flattenToc().map((t) => t.id);
    const nav = /<nav[^>]*aria-label="설명서 목차"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    expect([...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])).toEqual(ids);
    const select = /<select[^>]*aria-label="설명서 목차[^"]*"[^>]*>([\s\S]*?)<\/select>/.exec(html)![1];
    expect([...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)).toEqual(ids);
    const sections = [...html.matchAll(/data-guide-section="([^"]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(ids);
    for (const id of ids) expect(tags(html, "section").filter((t) => attrs(t).id === id)).toHaveLength(1);
    expect(tags(html, "h1")).toHaveLength(1);
  });
  it("links: /about is linked; every next/link has prefetch off; external links open safely", () => {
    links.length = 0;
    const html = render(EMPTY);
    expect(links.some((l) => l.href === "/about")).toBe(true);
    expect(links.filter((l) => l.prefetch !== false)).toEqual([]);
    for (const a of tags(html, "a").map(attrs).filter((a) => /^https?:/.test(a.href))) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
  });
  it("section 1 names every data source from the footer list (no other list to drift)", () => {
    const t = text(render(EMPTY));
    for (const c of CREDITS) expect(t).toContain(c.label);
  });
});

describe("screenshots", () => {
  it("missing screenshots render a clear placeholder that describes the screen — no <img>, no markers", () => {
    const html = render(EMPTY);
    expect(tags(html, "img")).toEqual([]);
    const figs = figures(html);
    expect(figs).toHaveLength(PLAN.shots.length);
    figs.forEach((f, i) => {
      const ph = tags(f, "div").map(attrs).find((a) => a["data-guide-placeholder"] != null)!;
      expect(ph.role).toBe("img");
      expect(ph["aria-label"]).toContain(PLAN.shots[i].alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
      expect(text(f)).toContain("1440×900"); // 찍을 크기를 적는다
      expect(text(f)).toContain("스크린샷 준비 중");
      expect(f).not.toContain("data-callout-marker");
    });
  });
  it("every image has alt · width · height · lazy loading · async decoding and a /guide/ source", () => {
    const html = render(FULL);
    const imgs = tags(html, "img").map(attrs);
    expect(imgs).toHaveLength(PLAN.shots.length);
    imgs.forEach((a, i) => {
      expect(a.alt?.length).toBeGreaterThan(0);
      expect(a.alt).toBe(PLAN.shots[i].alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
      expect(a.width).toBe("1440");
      expect(a.height).toBe("900");
      expect(a.loading).toBe("lazy");
      expect(a.decoding).toBe("async");
      expect(a.src).toBe(`/guide/${FULL.shots[PLAN.shots[i].id].file}`);
    });
    expect(html).not.toContain("스크린샷 준비 중");
  });
  it("callout numbers over the image match the numbered list; numbers not seen at capture are said so in the list", () => {
    const figs = figures(render(FULL));
    figs.forEach((f, i) => {
      const shot = PLAN.shots[i];
      const markers = [...f.matchAll(/data-callout-marker="(\d+)"[^>]*>(\d+)</g)].map((m) => [Number(m[1]), Number(m[2])]);
      const items = [...f.matchAll(/data-callout-item="(\d+)"/g)].map((m) => Number(m[1]));
      expect(items).toEqual(shot.callouts.map((c) => c.n));
      expect(markers.map(([n, shown]) => n === shown)).toEqual(markers.map(() => true)); // 겹침 글자 = 번호
      expect(markers.map(([n]) => n)).toEqual(shot.callouts.slice(0, -1).map((c) => c.n));
      expect(markers.every(([n]) => items.includes(n))).toBe(true);
      // 위치는 찍을 때 잰 값(%) 그대로
      const first = /data-callout-marker="1"[^>]*style="([^"]*)"|style="([^"]*)"[^>]*data-callout-marker="1"/.exec(f)!;
      expect(first[1] ?? first[2]).toContain("left:11%");
      expect(first[1] ?? first[2]).toContain("top:21%");
      const last = shot.callouts[shot.callouts.length - 1].n;
      const lastItem = new RegExp(`data-callout-item="${last}"[\\s\\S]*?</li>`).exec(f)![0];
      expect(text(lastItem)).toContain("이 스크린샷에는 보이지 않음");
      expect(text(f)).toContain(`그림 ${i + 1}`);
    });
  });
  it("capture meta follows the time rule (KST with UTC alongside) and names the capture condition", () => {
    const f = figures(render(FULL))[0];
    const t = text(f);
    expect(t).toContain("2026-09-29 14:22:11 KST · 05:22:11 UTC"); // 다른 화면과 같은 모양(KST · UTC, 같은 날이면 UTC 날짜 생략)
    expect(f).toMatch(/<time dateTime="2026-09-29T05:22:11.000Z"/);
    expect(t).toContain("한반도 #6.3/36.1/127.9");
    expect(t).toMatch(/WebP · 1440×900 · 88 KB/);
  });
  it("dropped manifest parts are shown at the top, each saying what it did to the figure (placeholder · image without that part · not in the plan)", () => {
    const html = render(EMPTY, [
      { text: "dashboard: file 이름이 …", effect: "placeholder" },
      { text: "search: variant(캡처 조건)가 …", effect: "partial" },
      { text: "nosuch: 계획에 없는 스크린샷", effect: "unused" },
    ]);
    expect(html).toMatch(/role="alert"/);
    const alert = text(html.slice(html.indexOf('role="alert"'), html.indexOf('data-guide-section="overview"')));
    expect(alert).toMatch(/항목을 버림 — 그 그림은 자리표시[\s\S]*dashboard: file 이름이/);
    expect(alert).toMatch(/일부만 버림 — 그림은 보이고 그 부분만 빠짐[\s\S]*search: variant/);
    expect(alert).toMatch(/계획에 없어 무시[\s\S]*nosuch/);
    // 해당 없는 묶음은 적지 않는다
    expect(text(render(EMPTY, [{ text: "search: variant …", effect: "partial" }]))).not.toMatch(/자리표시로 보입니다|항목을 버림/);
  });
});

/** 설명서 밖의 화면 코드(app · components · lib, guide 파일 제외) — 설명서가 없는 기능을 적지 않는지 대조한다 */
const WEB = new URL("..", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(join(WEB, d)).flatMap((n) => {
  const rel = join(d, n);
  return statSync(join(WEB, rel)).isDirectory() ? (n === "guide" ? [] : walk(rel)) : /\.tsx?$/.test(n) && !/guide/.test(n) ? [rel] : [];
});
const SCREENS = ["app", "components", "lib"].flatMap(walk).map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

/** 절 하나의 글 — 소절(g-sub)은 다음 절 시작 전까지, 절(g-sec)은 소절을 포함해 다음 절(g-sec) 전까지 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, id).toBeGreaterThanOrEqual(0);
  const top = /^<section[^>]*class="g-sec"/.test(html.slice(start));
  const rest = html.slice(start + 1);
  const next = rest.search(top ? /<section[^>]*class="g-sec"/ : /<section\b/);
  return text(next < 0 ? html.slice(start) : html.slice(start, start + 1 + next));
};

describe("features the guide describes exist in the screens", () => {
  // 오류 '해결' 표시(ADR-024 · 계약 v5 §G14): api(/ops/resolutions)와 화면(운영 · 로그의 해결 처리 · 가린 수 · 다시 보기 · 되돌리기)이 모두 있다.
  it("the resolve screens exist, so 6.2 and 6.3 describe them — hiding up to upto, never deleting", () => {
    expect(/ops\/resolutions|hidden_resolved/.test(SCREENS)).toBe(true);
    const html = render(EMPTY);
    const ops = section(html, "ops-dashboard");
    const logs = section(html, "ops-logs");
    for (const t of [ops, logs]) {
      expect(t).toMatch(/해결 처리/);
      expect(t).toMatch(/upto/);
      expect(t).toMatch(/지우지 않/);
      expect(t).toMatch(/되돌리기/);
      expect(t).toMatch(/다시 보입니다/); // upto 뒤의 재발
      expect(t).not.toMatch(/지울 수 있|삭제합니다/);
    }
    expect(logs).toContain("해결된 항목 보기");
    expect(logs).toContain("해결 처리로 숨김");
    expect(logs).toContain(RESOLVE_EFFECT.log_group);
    expect(ops).toContain("해결된 오류 포함");
    expect(ops).toContain(RESOLVE_EFFECT.provider_error);
    expect(ops).toMatch(/RESOLVE · UNRESOLVE/);
    expect(text(html)).toContain(RESOLUTION_STATE_TEXT.stale);
    expect(text(html)).toContain(RESOLUTION_STATE_TEXT.unavailable);
  });
  it("2.6 describes Korean port calls on the ship card: the server-side index, call-sign match, the window, when 'none' is said", () => {
    const ship = section(render(EMPTY), "dashboard-ship");
    expect(ship).toContain(PORT_CALL_TITLE);
    expect(ship).toMatch(/호출부호로만/);
    expect(ship).toMatch(/색인/);
    expect(ship).toMatch(/고를 때 외부에 묻지 않습니다/);
    expect(ship).toContain(`최근 ${PORT_CALL_WINDOW_DAYS}일`);
    expect(ship).toContain(`색인: ${PORT_CALL_AUTHORITIES}개 항만청 · 최근 ${PORT_CALL_WINDOW_DAYS}일 · 갱신`);
    expect(ship).toMatch(/기록 없음[^.]*모두 창 전체를 오늘\(KST\) 목록까지 빈 곳 없이 색인했고 2시간 안에 갱신됐을 때만/);
    expect(ship).toMatch(/최근 3일\s*은 그 시각까지 올라온 신고가 색인에 있고, 더 오래된 날은 마지막으로 다시 받은 때/); // 모든 날이 그 시각 기준이라고 말하지 않는다
    expect(ship).not.toMatch(/그 순간까지 올라온 신고가 색인에 있습니다/);
    expect(ship).toMatch(/끝까지 색인하지 못한 날/);
    expect(ship).toMatch(/아직 받지 않음/);
    expect(ship).not.toMatch(/조회 한도|6시간\(실패는 5분\)/); // 선택마다 묻던 설계의 한도 · 캐시는 없다
    expect(ship).toMatch(/00:00\(KST\)[^.]*날짜만/);
  });
  it("2.6 says when the card shows a stored static report and how it is labelled (static-fallback, contract v5 §G17)", () => {
    const ship = section(render(EMPTY), "dashboard-ship");
    expect(ship).toContain(`${STORED_STATIC_LABEL} · ${STORED_STATIC_TIME_LABEL} (KST · UTC)`);
    expect(ship).toMatch(/실시간 선박 스트림\(최대 2\.5 h\)에 그 선박의 정적 보고가 아직 없으면 DB 에 저장된 마지막 AIS 정적 보고/);
    expect(ship).toMatch(/실시간 값이 아니고/);
    expect(ship).toMatch(/DB 에 기록된 수신 시각[^.]*첫 수신도 마지막 수신도 아님/);
    expect(ship).toMatch(/수집기가 다시 시작했거나 그 선박을 30분 넘게 받지 못했다가/);
    expect(ship).not.toMatch(/첫 메시지를 받은 때/); // 리뷰: 재시작 · 제거 뒤에는 같은 내용도 새 시각이다
    // 계약 v5 §G19(리뷰): 저장 행은 받은 필드만 덮는다 — 그 시각의 보고가 싣지 않은 필드는 앞서 저장된 보고의 값
    expect(ship).toMatch(/저장 행은 받은 필드만 덮으므로 그 시각의 보고가 싣지 않은 필드[^.]*그보다 앞서 저장된 보고의 값입니다/);
    // 입출항은 서버가 그 보고를 읽었을 때만 그 호출부호로 찾는다(REST 로만 보일 때는 카드가 찾지 않았다고 적는다 — 리뷰)
    expect(ship).toMatch(/서버가 선택 때 그 보고를 읽었으면 입출항도 그 호출부호로 찾고, 읽지 못했으면 카드가 찾지 않았다고 적습니다/);
  });
  it("2.3 describes the coastal traffic layer: grid counts not positions, 5-minute snapshot, cells appear as their geometry is resolved", () => {
    const layers = section(render(EMPTY), "dashboard-layers");
    expect(layers).toContain(TRAFFIC_LAYER_LABEL);
    expect(layers).toContain(TRAFFIC_LEGEND_NOTE);
    expect(layers).toMatch(/5분/);
    expect(layers).toMatch(/개별 선박 위치가 아닙니다/);
    expect(layers).toMatch(/위치 확인 중/);
    expect(layers).toMatch(/자료 멈춤/);
    expect(section(render(EMPTY), "dashboard-legend")).toContain("연안 교통량");
  });
  it("2.8 explains the KMA composite size '합성 N/M곳'", () => {
    expect(section(render(EMPTY), "dashboard-radar")).toMatch(/합성 N\/M곳/);
  });
});

describe("rules the guide states match the code", () => {
  it("2.4 search input rules are what lib/search accepts (length bounds and characters)", () => {
    const sec = text(/<section[^>]*id="dashboard-search"[\s\S]*?<\/section>/.exec(render(EMPTY))![0]);
    const air = /항공기[^(]*\(([^)]*?)(\d+)–(\d+)자[^)]*\)/.exec(sec)!;
    const [lo, hi] = [Number(air[2]), Number(air[3])];
    expect(normalizeQuery("A".repeat(lo))).not.toBeNull();
    expect(normalizeQuery("A".repeat(lo - 1))).toBeNull();
    expect(normalizeQuery("A".repeat(hi))).not.toBeNull();
    expect(normalizeQuery("A".repeat(hi + 1))).toBeNull();
    expect(air[1].includes("-")).toBe(normalizeQuery("HL-8123") != null); // 등록번호의 '-'
    const ship = /선박[^(]*\((\d+)–(\d+)자, ([^)]*)\)/.exec(sec)!;
    expect(normalizeShipQuery("A".repeat(Number(ship[1])))).not.toBeNull();
    expect(normalizeShipQuery("A".repeat(Number(ship[1]) - 1))).toBeNull();
    expect(normalizeShipQuery("A".repeat(Number(ship[2])))).not.toBeNull();
    expect(normalizeShipQuery("A".repeat(Number(ship[2]) + 1))).toBeNull();
    for (const ch of [" ", ".", "-", "/"]) expect(normalizeShipQuery(`A${ch}B`)).not.toBeNull();
    expect(ship[3]).toMatch(/공백 \. - \//);
  });
});

describe("time examples", () => {
  it("section 7 states the §G13 rule with the shared formatter's own output (inline · compact · table cell · other UTC date · originals)", () => {
    const html = render(EMPTY);
    const t = section(html, "time");
    expect(t).toContain(fmtDual("2026-09-29T05:22:11Z")); // 09-29 14:22:11 KST · 05:22:11 UTC
    expect(t).toContain("09-29 14:22:11 KST · 05:22:11 UTC");
    expect(t).toContain(fmtDualCompact("2026-09-29T05:22:11Z")); // 14:22 KST · 05:22Z
    expect(t).toContain("09-30 05:30:00 KST · 09-29 20:30:00 UTC"); // UTC 날짜가 다르면 UTC 쪽에 날짜
    expect(t).toContain("290500Z"); // 원문은 발표 그대로
    expect(t).toContain(fmtUtcDayDual("2026-09-28")!);
    expect(t).toMatch(/§G13/);
    expect(text(html)).toMatch(/12:30 KST · 03:30 UTC/);
    // 표 칸 모양: 첫 줄 KST · 둘째 줄 UTC(DualTime cell — 화면 읽기에는 KST · UTC 로)
    expect(/<section id="time"[\s\S]*?<\/section>/.exec(html)![0]).toMatch(/<time dateTime="2026-09-29T05:22:11.000Z" class="block">09-29 14:22:11/);
  });
  it("unknown values are shown as — without a unit", () => {
    const t = text(render(EMPTY));
    expect(t).not.toMatch(/— (ft|kt|ms|m|km|s)\b/);
  });
});
