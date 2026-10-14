/** lib/route-param(QA-1424): Next 가 인코딩해 넘긴 동적 경로 값을 한 번만 디코딩한다 — 잘못된 % 표기는 그대로 */
import { describe, expect, it } from "vitest";
import { routeParam } from "@/lib/route-param";

describe("routeParam", () => {
  it("decodes the encoded segment once", () => {
    expect(routeParam(encodeURIComponent("김포 공항"))).toBe("김포 공항");
    expect(routeParam(encodeURIComponent("０１"))).toBe("０１");
    expect(routeParam("RKSI")).toBe("RKSI");
    expect(routeParam(encodeURIComponent("50%"))).toBe("50%"); // 사람이 친 % 는 %25 로 와서 % 로
  });
  it("keeps a malformed percent sequence as it came", () => {
    expect(routeParam("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
