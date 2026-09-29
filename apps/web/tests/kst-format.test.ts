/**
 * 운영(/ops)·로그(/logs) 화면의 시각을 한국 표준시(KST, UTC+09:00)로(사용자 요청 2026-09-29). 항공 자료 화면(상황판·재생·통계·공항)은 UTC 그대로.
 * - 표 칸은 "MM-DD HH:MM:SS"(머리글이 (KST) 를 말한다), 머리글이 없는 자리는 " KST" 를 붙인다. title 에 원본 UTC ISO(서버·컨테이너 로그와 대조).
 * - 복사 텍스트·.txt 의 머리 줄은 오프셋을 붙인 ISO 8601("…+09:00", ms 유지). .ndjson · JSON 복사는 api 가 준 그대로(ts 는 UTC).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { describe, expect, it } from "vitest";
import * as F from "@/lib/format";

/** 사용자가 붙여 넣은 /logs 항목(2026-09-28T23:41:14.906Z WARN collector/job.kma_radar) — UTC 자정 직전이라 KST 로는 다음 날 */
const USER_TS = "2026-09-28T23:41:14.906Z";

describe("KST formatters (lib/format)", () => {
  it("UTC 23:41 on 09-28 is 08:41 on 09-29 in KST — both sides of UTC and KST midnight", () => {
    expect(F.fmtTimeKst(USER_TS)).toBe("09-29 08:41:14");
    expect(F.fmtTimeKst("2026-09-28T14:59:59Z")).toBe("09-28 23:59:59"); // KST 자정 직전
    expect(F.fmtTimeKst("2026-09-28T15:00:00Z")).toBe("09-29 00:00:00"); // KST 자정
    expect(F.fmtTimeKst("2026-09-29T00:00:00Z")).toBe("09-29 09:00:00"); // UTC 자정
    expect(F.fmtIsoKst("2026-12-31T15:00:00Z")).toBe("2027-01-01T00:00:00.000+09:00"); // 해가 바뀜
    expect(F.fmtIsoKst("2028-02-28T15:00:00Z")).toBe("2028-02-29T00:00:00.000+09:00"); // 윤일
    expect(F.fmtTimeKst(Date.parse(USER_TS))).toBe("09-29 08:41:14"); // 숫자는 epoch ms
  });
  it("label (no column header), clock and ISO-with-offset forms; the UTC original goes to the tooltip", () => {
    expect(F.fmtTimeKstLabel(USER_TS)).toBe("09-29 08:41:14 KST");
    expect(F.fmtClockKst(USER_TS)).toBe("08:41:14 KST");
    expect(F.fmtIsoKst(USER_TS)).toBe("2026-09-29T08:41:14.906+09:00");
    expect(F.fmtIsoKst("2026-09-29T08:41:14.906+09:00")).toBe("2026-09-29T08:41:14.906+09:00"); // 이미 KST 인 ISO 도 같은 순간
    expect(Date.parse(F.fmtIsoKst(USER_TS))).toBe(Date.parse(USER_TS)); // 같은 순간(표기만 바뀐다)
    expect(F.fmtUtcTitle(USER_TS)).toBe("원본 UTC 2026-09-28T23:41:14.906Z");
  });
  it("unknown or unreadable → \"—\" (and no tooltip), never a made-up time; out-of-range values do not throw", () => {
    for (const v of [null, undefined, "", "bad", "undefined", "null", Number.NaN]) {
      expect(F.fmtTimeKst(v)).toBe("—");
      expect(F.fmtTimeKstLabel(v)).toBe("—");
      expect(F.fmtClockKst(v)).toBe("—");
      expect(F.fmtIsoKst(v)).toBe("—");
      expect(F.fmtUtcTitle(v)).toBeUndefined();
    }
    expect(() => F.fmtIsoKst(8.64e15)).not.toThrow(); // Date 의 최대 순간 + 9 h 는 Date 범위 밖
    expect(F.fmtIsoKst(8.64e15)).toBe("—");
  });
  it("the fixed +09:00 offset agrees with the tz database (Intl, Asia/Seoul) for 2000–2040 — Korea has had no DST since 1988", () => {
    const tz = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const viaIntl = (ms: number) => {
      const p = Object.fromEntries(tz.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    };
    const start = Date.UTC(2000, 0, 1, 0, 0, 7), end = Date.UTC(2040, 11, 31);
    let n = 0;
    for (let t = start; t < end; t += 6 * 86_400_000 + 3_601_000) { expect(F.fmtIsoKst(t).slice(0, 19)).toBe(viaIntl(t)); n++; }
    expect(n).toBeGreaterThan(2_000);
  });
  it("does not depend on the machine's time zone (the formatter never reads local time)", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(F.fmtTimeKst(USER_TS)).toBe("09-29 08:41:14");
      expect(F.fmtIsoKst(USER_TS)).toBe("2026-09-29T08:41:14.906+09:00");
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });
});
