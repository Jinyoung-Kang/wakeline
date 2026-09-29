/**
 * 이력 재생(/replay)은 한국 표준시만(계약 v5 §G19 — 사용자 결정 2026-09-30 "UTC 지우고 KST"): 사용자는 KST 로 고르고 읽고, api 는 그대로 그 순간의
 * UTC ISO(…Z — 저장 · 전송 형식)를 받는다. 날짜·시각 입력(datetime-local)은 KST(+09:00)로 읽고 쓴다 — 자정 · 달 · 해가 바뀌는 곳에서 하루 어긋나지 않는지 본다.
 * 보이는 글자 · title 에는 UTC 가 없다. 원문(SIGMET raw)은 발표된 그대로. 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as R from "@/lib/replay";
import ReplayPage from "@/app/replay/page";
import { utcLeaks } from "./helpers/kst-only";

describe("replay time input is KST; the api still receives UTC", () => {
  it("KST input → UTC instant across KST midnight, month end, year end and a leap day", () => {
    expect(R.fromKstInput("2026-09-29T00:10")).toBe(Date.parse("2026-09-28T15:10:00Z")); // KST 자정 직후 = UTC 전날
    expect(R.fromKstInput("2026-09-29T08:59")).toBe(Date.parse("2026-09-28T23:59:00Z")); // UTC 자정 직전
    expect(R.fromKstInput("2026-09-29T09:00")).toBe(Date.parse("2026-09-29T00:00:00Z")); // UTC 자정
    expect(R.fromKstInput("2026-10-01T05:00")).toBe(Date.parse("2026-09-30T20:00:00Z")); // 달이 바뀜
    expect(R.fromKstInput("2027-01-01T03:00")).toBe(Date.parse("2026-12-31T18:00:00Z")); // 해가 바뀜
    expect(R.fromKstInput("2028-02-29T05:00")).toBe(Date.parse("2028-02-28T20:00:00Z")); // 윤일
    expect(R.fromKstInput("2026-09-29T00:10:30")).toBe(Date.parse("2026-09-28T15:10:30Z")); // 초까지
  });
  it("UTC instant → KST input value, and the round trip is exact to the minute", () => {
    expect(R.toKstInput(Date.parse("2026-09-28T15:10:40Z"))).toBe("2026-09-29T00:10");
    expect(R.toKstInput(Date.parse("2026-12-31T18:00:00Z"))).toBe("2027-01-01T03:00");
    expect(R.toKstInput(Number.NaN)).toBe("");
    for (const iso of ["2026-09-28T14:59:00Z", "2026-09-28T15:00:00Z", "2026-09-28T23:59:00Z", "2026-09-29T00:00:00Z", "2028-02-28T15:00:00Z"]) {
      expect(R.fromKstInput(R.toKstInput(Date.parse(iso)))).toBe(Date.parse(iso));
    }
  });
  it("impossible or malformed input is rejected, never shifted to another day", () => {
    for (const v of ["", "2026-02-30T03:05", "2026-02-29T05:00", "2026-09-31T00:00", "2026-09-29T24:00", "2026-09-29 00:10", "garbage"]) expect(R.fromKstInput(v)).toBeNull();
  });
  it("the api request carries the UTC instant (ISO …Z) of the KST time the user picked", () => {
    const at = R.fromKstInput("2026-09-29T00:10")!;
    expect(R.replayApiPath({ at, bbox: "124,33,132,39" })).toBe("/api/v1/replay?at=2026-09-28T15%3A10%3A00.000Z&bbox=124%2C33%2C132%2C39");
  });
  it("shown times: the chosen time, the drawn frame, record times, radar and SIGMET validity are KST only (year on the replay time)", () => {
    const at = Date.parse("2026-09-28T15:10:00Z");
    expect(R.replayAtLabel(at)).toBe("2026-09-29 00:10:00 KST"); // UTC 로는 전날 — KST 날짜만
    expect(R.replayAtLabel(Date.parse("2026-09-29T05:10:00Z"))).toBe("2026-09-29 14:10:00 KST");
    expect(R.replayAtLabel(0)).toBe("—");
    expect(R.replayFrameAtLabel({ at: "2026-09-28T15:10:00Z" }, at)).toEqual({ text: "2026-09-29 00:10:00 KST", behind: false });
    expect(R.replayFrameAtLabel({ at: "2026-09-28T15:09:00Z" }, at)).toEqual({ text: "2026-09-29 00:09:00 KST", behind: true });
    expect(R.replayRadarLabel({ at: "2026-09-28T15:10:00Z", radar: { host: "h", path: "/p", time: Date.parse("2026-09-28T15:00:00Z") / 1000 } })).toBe("레이더 09-29 00:00:00 KST (재생 시각 −10분)");
    expect(R.replayRadarTitle({ at: "2026-09-28T15:10:00Z", radar: { host: "h", path: "/p", time: Date.parse("2026-09-28T15:00:00Z") / 1000 } })).toBe("2026-09-29 00:00:00.000 KST");
    expect(R.replayRecLabel({ ts: "2026-09-28T15:09:30Z", provider: "adsb_fi" }, "2026-09-28T15:10:00Z")).toBe("09-29 00:09:30 KST (재생 시각 −30s)");
    expect(R.replayRecLabel({ ts: "2026-09-28T14:59:00Z", provider: R.SUMMARY_PROVIDER }, "2026-09-28T15:10:00Z")).toBe("09-28 23:59:00 – 09-29 00:00:00 KST 평균");
    expect(R.replayRecTitle({ ts: "2026-09-28T14:59:00Z", provider: R.SUMMARY_PROVIDER })).toBe("2026-09-28 23:59:00.000 KST – 2026-09-29 00:00:00.000 KST");
    expect(Object.fromEntries(R.replayAircraftRows({ hex: "71c081", lat: 36, lon: 127, ts: "2026-09-28T15:09:30Z", provider: "adsb_fi" }, "2026-09-28T15:10:00Z"))["기록 시각"]).toBe("09-29 00:09:30 KST");
    const sg = { id: "S", hazard: "TS", fir_id: "RKRR", valid_from: "2026-09-28T14:00:00Z", valid_to: "2026-09-28T18:00:00Z", raw_text: "RKRR SIGMET 1 VALID 281400/281800 RKSI-", geometry: null };
    expect(Object.fromEntries(R.replaySigmetTip(sg, "2026-09-28T15:10:00Z").rows).VALID).toBe("09-28 23:00 – 09-29 03:00 KST");
    const texts = [R.replayAtLabel(at), R.replayFrameAtLabel({ at: "2026-09-28T15:10:00Z" }, at).text, R.replayRecLabel({ ts: "2026-09-28T15:09:30Z" }, "2026-09-28T15:10:00Z"),
      R.replayRecTitle({ ts: "2026-09-28T15:09:30Z" }) ?? "", ...R.replaySigmetTip(sg, "2026-09-28T15:10:00Z").rows.map(([, v]) => v)];
    for (const t of texts) expect(utcLeaks(t), t).toEqual([]);
  });
  it("one KST pick end to end: input value → shown label → the api instant, across the KST and UTC day changes", () => {
    for (const [input, label, utc] of [
      ["2026-09-29T00:00", "2026-09-29 00:00:00 KST", "2026-09-28T15:00:00.000Z"], // KST 자정 = UTC 전날 15:00
      ["2026-09-29T08:59", "2026-09-29 08:59:00 KST", "2026-09-28T23:59:00.000Z"], // UTC 날짜가 아직 전날
      ["2026-09-29T09:00", "2026-09-29 09:00:00 KST", "2026-09-29T00:00:00.000Z"], // UTC 자정
      ["2027-01-01T00:30", "2027-01-01 00:30:00 KST", "2026-12-31T15:30:00.000Z"], // KST 로 새해, UTC 로는 전해
      ["2028-02-29T03:00", "2028-02-29 03:00:00 KST", "2028-02-28T18:00:00.000Z"], // 윤일
    ] as const) {
      const at = R.fromKstInput(input)!;
      expect(R.replayAtLabel(at), input).toBe(label);
      expect(R.toKstInput(at), input).toBe(input);
      expect(R.replayApiPath({ at, bbox: "1,2,3,4" }), input).toBe(`/api/v1/replay?at=${encodeURIComponent(utc)}&bbox=1%2C2%2C3%2C4`);
    }
  });
  it("the toolbar names KST next to the date-time input (browsers render it in their own locale format)", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage));
    expect(html).toMatch(/>KST<\/span><input type="datetime-local"/);
    expect(html).toMatch(/<input[^>]*aria-label="재생 시각\(KST\)"/);
    expect(html).not.toContain("재생 시각(UTC)");
    expect(utcLeaks(html.replace(/<[^>]+>/g, " "))).toEqual([]);
    expect([...html.matchAll(/title="([^"]*)"/g)].flatMap((m) => utcLeaks(m[1]))).toEqual([]);
  });
});
