/**
 * 기상청 '파일 없음' 연속 중 목록도 자라지 않을 때(운영 2026-10-01 00:50 KST — 계약 v5 §G26 개정).
 * 운영에서 본 것: 기상청 목록은 tm=20260930 이 19:50 에서 끝났고 20261001 은 비었거나 HTTP 504 였다. 수집기의 확인 주기(00:20 · 00:35 · 00:50)는 확인할 tm 이
 * 없어 'ok' 로 끝났고 연속의 마지막 확인(checked_at)을 옮기지 않아, KMA 칩이 "STALE 파일 없음 · 확인 멈춤"이라 했다 — 수집기는 확인하고 있었다.
 * 이제 수집기는 목록만 읽은 확인도 마지막 확인으로 옮기고, 목록이 보인 것을 싣는다: api missing.list_tm(마지막 확인에서 읽은 목록의 가장 새 tm) ·
 * list_newer(그 목록이 확인 전 last_tm 뒤로 실은 tm 수 — 0 이면 목록도 자라지 않았다). 화면은 0 일 때 "기상청 목록에도 19:50 KST 뒤 새 tm 없음"을
 * KMA 칩 title · 상세 행 · 레이더 패널 · 운영 줄에 적는다(KST 만 · 값은 api 그대로 · 모르면 적지 않는다). '확인 멈춤'은 진짜로 확인이 멈췄을 때만.
 * 고치기 전 코드에서 실패하는 것을 먼저 확인했다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { krMissing } from "@/lib/kr-radar";
import { providerMissing, RUN_STATUS_TITLE } from "@/lib/ops";
import { validateServerMessage } from "@/lib/ws-validate";
import { getData, resetData, setData } from "@/lib/store";
import { detailRows, statusChips, statusInput } from "@/lib/statusbar";
import { KrRadarPanel } from "@/components/KrRadarPanel";
import type { KrRadar, KrRadarMissing } from "@/lib/types";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
/** 00:52 KST(10-01) — 마지막 확인(00:50:11 KST) 뒤 2분 */
const NOW = Date.parse("2026-09-30T15:52:00Z");
/** 운영 모양: 13:10 부터 없음, 19:50 이 마지막으로 없다는 답을 받은 tm, 목록도 19:50 에서 멈췄다(확인 전 last_tm 뒤로 0개) */
const IDLE: KrRadarMissing = {
  since_tm: "202609301310", last_tm: "202609301950", tms: 58, checked_at: "2026-09-30T15:50:11Z",
  file: "RDR_CMP_HSR_PUB_202609301950.bin.gz", listed: ["EXT"], probe_every_s: 900, list_tm: "202609301950", list_newer: 0,
};
const HEAD = "기상청 내려받기 파일(PUB) 없음 — tm 09-30 13:10–19:50 KST · 확인한 tm 58개 모두 없음 · 목록에는 EXT";
const IDLE_WORDS = "기상청 목록에도 09-30 19:50 KST 뒤 새 tm 없음";
const LINE = `${HEAD} · ${IDLE_WORDS} · 마지막 확인 00:50:11 KST · 15분마다 확인`;

function kr(o: Partial<KrRadar> = {}): KrRadar {
  const f = { tm: "202609300810", obs_tm: "202609300810", fetched_at: "2026-09-29T23:13:40Z", echo_cells: 12, url: "/api/v1/radar/kr/202609300810.png?v=1" };
  return {
    available: true, latest_tm: "202609300810", georeferenced: true, coordinates: null, legend: [[5, [120, 190, 255, 150]]], min_dbz: "5.0",
    frames: [f], attribution: "기상청", meta: { fetched_at: "2026-09-29T23:13:40Z", stale: true }, missing: IDLE, ...o,
  } as KrRadar;
}

describe("krMissing: the listing did not grow past the last tm either", () => {
  it("names it in the one line (KST only) and keeps 확인 멈춤 off while the collector keeps checking", () => {
    const m = krMissing(IDLE, NOW)!;
    expect(m.text).toBe(LINE);
    expect(m.word).toBe("파일 없음");
    expect(m.stale).toBe(false);
    expect(m.listIdle).toBe(true);
    expect(m.listText).toBe(IDLE_WORDS);
    expect(m.title).toContain("마지막 확인에서 읽은 기상청 목록에도 09-30 19:50 KST 뒤 새 tm 없음 — 목록의 가장 새 tm 09-30 19:50 KST(목록이 자라지 않아 확인할 새 tm 이 없음)");
    expect(`${m.text}\n${m.title}`).not.toMatch(/UTC|\d\d:\d\d(:\d\d)?Z\b|\+00:00/);
  });
  it("an empty listing (the new KST day not listed yet) says the listing had no tm — never a guessed newest tm", () => {
    const m = krMissing({ ...IDLE, list_tm: undefined }, NOW)!;
    expect(m.text).toBe(LINE);
    expect(m.title).toContain("마지막 확인에서 읽은 기상청 목록에도 09-30 19:50 KST 뒤 새 tm 없음 — 읽은 목록에 tm 없음");
  });
  it("a growing listing (list_newer > 0) or an unknown one adds no idle words", () => {
    const grew = krMissing({ ...IDLE, list_tm: "202609301950", list_newer: 3 }, NOW)!;
    expect(grew.listIdle).toBe(false);
    expect(grew.text).not.toContain("목록에도");
    expect(grew.title).toContain("마지막 확인의 목록: 가장 새 tm 09-30 19:50 KST · 확인 전 마지막 tm 뒤로 3개를 더 실음");
    for (const unknown of [{ list_newer: undefined }, { list_newer: null }, { list_newer: -1 }, { list_newer: 1.5 }, { list_newer: "0" }]) {
      const m = krMissing({ ...IDLE, ...unknown } as unknown as KrRadarMissing, NOW)!;
      expect(m.listIdle, JSON.stringify(unknown)).toBe(false);
      expect(m.text, JSON.stringify(unknown)).not.toContain("목록에도");
    }
    // 0 인데 목록의 가장 새 tm 이 last_tm 뒤 — 서로 맞지 않는다(0 은 last_tm 뒤로 싣지 않았다는 뜻): '새 tm 없음'을 말하지 않는다
    expect(krMissing({ ...IDLE, list_tm: "202609301955" }, NOW)!.listIdle).toBe(false);
    // 틀린 list_tm 은 모름 — 0 은 그대로(가장 새 tm 만 쓰지 않는다). 없는 것(빈 목록)과 달리 '읽은 목록에 tm 없음'이라 하지 않는다
    const badTm = krMissing({ ...IDLE, list_tm: "19:50" }, NOW)!;
    expect(badTm.listIdle).toBe(true);
    expect(badTm.title).toContain("마지막 확인에서 읽은 기상청 목록에도 09-30 19:50 KST 뒤 새 tm 없음\n");
    expect(badTm.title).not.toContain("읽은 목록에 tm 없음");
  });
  it("확인 멈춤 stays for a real stop of the checks — the last check older than 3 intervals, idle or not", () => {
    const at = Date.parse(IDLE.checked_at);
    expect(krMissing(IDLE, at + 45 * 60_000)!.stale).toBe(false);
    const old = krMissing(IDLE, at + 45 * 60_000 + 1000)!;
    expect(old.stale).toBe(true);
    expect(old.word).toBe("파일 없음 · 확인 멈춤");
    expect(old.text).toBe(`${LINE} — 45분 넘게 다시 확인하지 않음(확인 멈춤)`);
  });
});

describe("the KMA chip, 상세, the KMA panel and the ops row say the listing has nothing new", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  it("chip title and word title carry the sentence; 상세 row value names it; the last check (KST) is in the source", () => {
    setData({ radarKr: kr() });
    const c = statusChips(statusInput(getData(), NOW, NOW)).find((x) => x.key === "kma")!;
    expect(c.words.map((w) => w.text)).toEqual(["STALE", "파일 없음"]); // 확인 멈춤 아님 — 마지막 확인은 2분 전
    expect(c.title).toContain(LINE);
    expect(c.words[1].title).toContain(IDLE_WORDS);
    const row = detailRows(statusInput(getData(), NOW, NOW)).find((r) => r.key === "kma-missing")!;
    expect(row.state).toBe("없음");
    expect(row.value).toBe(`tm 09-30 13:10–19:50 KST · 확인한 tm 58개 모두 없음 · ${IDLE_WORDS}`);
    expect(row.source).toContain("마지막 확인 00:50:11 KST");
    expect(row.rule).toContain("목록이 마지막 tm 뒤로 새 tm 을 싣지 않으면 ‘목록에도 … 뒤 새 tm 없음’");
  });
  it("the KMA panel", () => {
    setData({ radarKr: kr() });
    const html = text(renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} })));
    expect(html).toContain("기상청 목록에도 09-30 19:50 KST 뒤 새 tm 없음");
  });
  it("the ops row reads missing_list_tm · missing_list_newer from the provider hash (strings, checked here)", () => {
    const P = { name: "kma_radar", missing_since_tm: "202609301310", missing_last_tm: "202609301950", missing_tms: "58",
      missing_checked_at: "2026-09-30T15:50:11Z", missing_file: "RDR_CMP_HSR_PUB_202609301950.bin.gz", missing_listed: "EXT", missing_probe_every_s: "900",
      missing_list_tm: "202609301950", missing_list_newer: "0" };
    expect(providerMissing(P, NOW)?.text).toBe(LINE);
    expect(providerMissing({ ...P, missing_list_tm: "" }, NOW)?.text).toBe(LINE); // 목록이 비었다 — 0 은 그대로
    for (const v of ["", "none", "-1", "1.0"]) expect(providerMissing({ ...P, missing_list_newer: v }, NOW)?.listIdle, v).toBe(false);
  });
  it("run status missing now also covers a check that only read the listing — named in its explanation", () => {
    expect(RUN_STATUS_TITLE.missing).toContain("'파일 없음'으로 답함");
    expect(RUN_STATUS_TITLE.missing).toContain("목록에도 새 tm 이 없던 확인");
    expect(RUN_STATUS_TITLE.missing).toContain("nothing to probe");
  });
  it("run status missing also covers a listing stall outside a streak (collector lane kma 8th pass) — named in its explanation", () => {
    // 수집기(jobs/kma_radar.py _ListIdle): 연속이 없어도 저장한 최신 tm 을 처음 저장한 뒤 15분 넘게 목록에 그보다 새 tm 이 없으면 'missing'
    expect(RUN_STATUS_TITLE.missing).toContain("연속이 없어도");
    expect(RUN_STATUS_TITLE.missing).toContain("the KMA listing … has no tm after");
    expect(RUN_STATUS_TITLE.missing).toContain("15분");
  });
});

describe("WS status: radar_kr.missing list_tm · list_newer pass the validator; wrong ones drop the message", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ws-samples.v1.json", import.meta.url), "utf8")) as { server: { name: string; message: Record<string, unknown> }[] };
  /** api 빌더가 만든 표본(status.populated — radar_kr.missing 에 list_tm · list_newer 가 있다)에 값을 덮어쓴다 */
  const status = (over: Record<string, unknown>) => {
    const m = structuredClone(fixture.server.find((x) => x.name === "status.populated")!.message) as { status: { radar_kr: { missing: Record<string, unknown> } } };
    const miss = m.status.radar_kr.missing;
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete miss[k]; else miss[k] = v;
    return m;
  };
  it("the api sample carries the fields and the web validator accepts them (and their absence)", () => {
    const m = status({});
    expect(m.status.radar_kr.missing).toMatchObject({ list_tm: "202609290525", list_newer: 0 });
    expect(validateServerMessage(m).kind).toBe("ok");
    expect(validateServerMessage(status({ list_tm: undefined, list_newer: undefined })).kind).toBe("ok");
  });
  it("rejects wrong shapes", () => {
    for (const bad of [{ list_tm: "19:50" }, { list_newer: -1 }, { list_newer: "0" }, { list_newer: 1.5 }]) {
      expect(validateServerMessage(status(bad)).kind, JSON.stringify(bad)).toBe("invalid");
    }
  });
});
