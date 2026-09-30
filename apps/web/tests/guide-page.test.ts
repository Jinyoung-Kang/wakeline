/**
 * 설명서 화면(/guide) — 서버 렌더 결과로 확인한다(정적 렌더 · 클라이언트 자바스크립트는 목차의 현재 위치 표시와 좁은 화면 선택 상자뿐).
 * - 목차(넓은 화면 목록 · 좁은 화면 선택 상자)의 앵커와 절 id 가 같다(순서까지).
 * - 스크린샷: 결과(manifest)가 있으면 <img>(대체 글 · width · height · loading=lazy · decoding=async), 없으면 "스크린샷 준비 중" 자리표시.
 * - 번호: 그림 위 번호(HTML 겹침 — 이미지에 굽지 않음)마다 같은 번호의 설명 항목이 있고, 설명 목록은 1..n. 찍을 때 보이지 않은 번호는 목록에 그렇다고 적는다.
 * - 시각이 나오는 예는 KST 만 적는다(계약 v5 §G20 — 공유 형식기 lib/time 의 글자, 원문 토큰만 발표 그대로). 출처는 하단 출처 줄과 같은 목록(lib/attribution)에서.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KR_MISSING_CHECK_STALE_MIN } from "@/lib/kr-radar";
import { HEALTH_MARK } from "@/lib/statusbar";
import { describe, expect, it, vi } from "vitest";
import { CREDITS } from "@/lib/attribution";
import { normalizeQuery, normalizeShipQuery } from "@/lib/search";
import { flattenToc, parseManifest, PLAN, type GuideManifest, type ManifestDrop } from "@/lib/guide";
import { PORT_CALL_AUTHORITIES, PORT_CALL_TITLE, PORT_CALL_WINDOW_DAYS } from "@/lib/portcalls";
import { RESOLUTION_STATE_TEXT, RESOLVE_EFFECT } from "@/lib/resolutions";
import { STORED_STATIC_LABEL, STORED_STATIC_TIME_LABEL } from "@/lib/ships";
import { fmtKst, fmtKstMinute, utcDayWindowKst } from "@/lib/time";
import { htmlUtcLeaks, utcLeaks } from "./helpers/kst-only";
import { parseHtml } from "./helpers/html-tree";
import { TRAFFIC_LAYER_LABEL, TRAFFIC_LEGEND_NOTE } from "@/lib/traffic-grid";
import { RECEPTION_LAYER_LABEL } from "@/lib/reception-meta";

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
  it("capture meta follows the time rule (KST only, with the year) and names the capture condition", () => {
    const f = figures(render(FULL))[0];
    const t = text(f);
    expect(t).toContain("캡처 2026-09-29 14:22:11 KST"); // 다른 화면과 같은 모양(계약 v5 §G20 — KST 만)
    expect(utcLeaks(t)).toEqual([]);
    expect(f).toMatch(/<time dateTime="2026-09-29T14:22:11.000\+09:00"/);
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
  // 2.3 은 상태 바의 기상청 칩을 설명한다 — 예전 별도 배지 'KMA STALE'(badge bad)는 상태 바 칩(KMA ✕ age … STALE)으로 바뀌었다(계약 v5 §G20 · 상태 바 개편).
  it("2.3 describes the KMA stale state as the status bar's KMA chip, not the removed red badge", () => {
    const t = text(section(render(EMPTY), "dashboard-radar"));
    expect(t).not.toMatch(/KMA STALE/);
    expect(t).toContain(`KMA ${HEALTH_MARK.bad} age`);
    expect(t).toMatch(/STALE/);
  });
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
    expect(ship).toContain(`${STORED_STATIC_LABEL} · ${STORED_STATIC_TIME_LABEL} (KST)`);
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
    // ADR-023 2026-10-01 개정: 배가 있는 칸이 바뀌어 새 칸이 계속 나타난다 — 채우기가 끝나는 때(예전 '처음 약 18시간 이상')를 말하지 않고 속도 한도만
    expect(layers).not.toMatch(/18시간/);
    expect(layers).toMatch(/시간당 많아야 290칸[^.]*하루 6,000칸[^.]*모든 칸이 보이게 되는 때는 적지 않습니다/);
  });
  it("the ops providers tab explains the traffic-grid fill row and that a stale heartbeat shows no numbers", () => {
    const ops = section(render(EMPTY), "ops-dashboard");
    expect(ops).toMatch(/‘연안 교통량 격자 위치’ 줄[^.]*heartbeat 그대로[^.]*끝나는 때는 적지 않음/);
    expect(ops).toMatch(/120 s 넘게 지났으면 수 대신 ‘heartbeat 오래됨 — 마지막 …’/);
  });
  it("2.6 explains the observed reception layer (ADR-027): measured cells, not the subscription area, the partial-window notice and the chip count", () => {
    const ship = section(render(EMPTY), "dashboard-ship");
    expect(ship).toContain(RECEPTION_LAYER_LABEL);
    expect(ship).toMatch(/실제로 선박 위치를 받은 0\.5° 칸/);
    expect(ship).toMatch(/점선[^.]*구독[^.]*잰 값/);
    expect(ship).toMatch(/창의 일부만 셈/);
    expect(ship).toMatch(/이 화면에 관측 수신 칸 N개/);
    expect(ship).toMatch(/부터만 셈/); // 창을 다 세지 못했으면 칩 · 0척 알림도 센 구간을 적는다(리뷰 2026-09-30)
    // 서버가 기동 때 못 읽은 시(계약 v5 §G27 개정 — 2026-09-30 22:49 KST 배포 직후): 다시 읽기 대기와 다음 시각 · 끝내 포기한 시
    // 리뷰 2026-10-01: 길이는 실제 길이(조각 수가 아니다) · 차례 마감으로 미룬 시는 '아직 조회하지 않음' · 포기한 시는 까닭마다 못 읽은 횟수
    expect(ship).toMatch(/빈 시 1시간 30분\(… KST\) 다시 읽기 대기 — 까닭 · 다음 … KST/);
    expect(ship).toMatch(/실제 길이/);
    expect(ship).toMatch(/차례 마감으로 아직 조회하지 않음/);
    expect(ship).toMatch(/포기 — 까닭\(n번 못 읽음\) · api 재시작 전까지 빈 시/);
  });
  it("4 says each stats panel is loading or failed on its own — the empty-state text is only for an answer that came back (2026-09-30 22:49 KST capture)", () => {
    const stats = section(render(EMPTY), "stats");
    expect(stats).toMatch(/받는 중 · 받지 못함/);
    expect(stats).toContain("‘불러오는 중’");
    expect(stats).toMatch(/그 패널만 ‘조회 실패’와 HTTP 상태 · 요청 id · 다시 시도/);
    expect(stats).toMatch(/응답을 받은 패널에만/);
    expect(section(render(EMPTY), "dashboard-layers")).toContain(RECEPTION_LAYER_LABEL);
    expect(section(render(EMPTY), "dashboard-legend")).toContain("관측 수신 범위");
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
  it("section 7 states the §G20 rule (KST only) with the shared formatter's own output (inline · minute · table cell · tooltip · raw token · KST day · budget window)", () => {
    const html = render(EMPTY);
    const t = section(html, "time");
    expect(t).toContain(fmtKst("2026-09-29T05:22:11Z")); // 09-29 14:22:11 KST
    expect(t).toContain("09-29 14:22:11 KST");
    expect(t).toContain(fmtKstMinute("2026-09-29T05:22:11Z")); // 14:22 KST
    expect(t).toContain("2026-09-29 14:22:11.000 KST"); // 마우스를 올리면(연도 · ms)
    expect(t).toContain("290500Z"); // 원문은 발표 그대로(data-raw)
    expect(t).toContain("09-28 00:00 – 09-28 23:59 KST"); // 통계 날짜 = KST 날짜
    expect(t).toContain(utcDayWindowKst("2026-09-28")!); // 공급자 예산 창 "09-28 09:00 – 09-29 08:59 KST"
    expect(t).toMatch(/§G20/);
    expect(text(html)).toMatch(/매일 03:30 KST 에 전날/); // 통계 집계 시각(api 03:30 KST — 계약 v5 §G20)
    const sec = /<section id="time"[\s\S]*?<\/section>/.exec(html)![0];
    // 표 칸 모양: KST 한 줄(머리글 "(KST)" — 화면 읽기에는 KST)
    expect(sec).toMatch(/<time dateTime="2026-09-29T14:22:11.000\+09:00" title="2026-09-29 14:22:11.000 KST" class="mono whitespace-nowrap">09-29 14:22:11<span class="sr-only"> KST<\/span><\/time>/);
    // 한 시각은 줄바꿈하지 않는다 — 구간은 " – " 에서만(화면에서 "23:59 / KST" 로 갈라지던 것을 막는다)
    expect(sec).toContain('<span class="whitespace-nowrap">09-28 00:00</span> – <span class="whitespace-nowrap">09-28 23:59 KST</span>');
    expect(sec).toContain('<span class="whitespace-nowrap">09-28 09:00</span> – <span class="whitespace-nowrap">09-29 08:59 KST</span>');
    expect(sec).toContain('<span class="mono whitespace-nowrap">2026-09-29 14:22:11.000 KST</span>');
    // 원문 토큰 밖에는 UTC 가 없다(설명서 전체)
    expect(htmlUtcLeaks(parseHtml(html))).toEqual([]);
  });
  // 통합 리뷰(2026-09-30): 6.2 의 운영 탭 표가 이번 통합의 화면(PIPELINE 의 AIS 수신 진단 · 실행 상태 missing/quarantined · kma_radar '파일 없음' 줄)을 말한다
  it("6.2 names the pipeline tab's AIS receive diagnostics, the missing/quarantined run statuses and the KMA 'file not exist' line", () => {
    const ops = text(section(render(EMPTY), "ops-dashboard"));
    expect(ops).toMatch(/AIS 수신 진단/);
    for (const k of ["keepalive 왕복", "이벤트 루프 지연", "WS 수신 버퍼", "원문 대기 시간", "짧은 재연결"]) expect(ops).toContain(k);
    expect(ops).toMatch(/손실 수가 아니라 색으로 판정하지 않습니다/);
    expect(ops).toMatch(/수집기 설정/);
    expect(ops).toMatch(/missing/);
    expect(ops).toMatch(/quarantined/);
    expect(ops).toMatch(/마지막 성공을 갱신하지 않습니다/);
    expect(ops).toMatch(/kma_radar 행 아래/);
    // 계약 v5 §G26: 긴 연속은 늘린 간격(수집기 선택값)으로 확인 — '확인 멈춤' 기준은 확인 간격 × 3(아래로 15분)
    expect(ops).toContain(`확인 간격 × 3(아래로 ${KR_MISSING_CHECK_STALE_MIN}분)을 넘으면 ‘확인 멈춤’`);
    expect(ops).toMatch(/15분마다 확인/);
    expect(ops).toMatch(/waiting/);
    expect(ops).not.toMatch(/최근 60 s/); // 창 길이는 수집기 설정 — 설명서가 숫자를 들고 있지 않다
  });
  it("unknown values are shown as — without a unit", () => {
    const t = text(render(EMPTY));
    expect(t).not.toMatch(/— (ft|kt|ms|m|km|s)\b/);
  });
});
