import { describe, expect, it } from "vitest";
import { subscriptionBbox } from "@/lib/viewport";

describe("subscriptionBbox (antimeridian)", () => {
  it("keeps an ordinary view as is", () => {
    expect(subscriptionBbox(124, 33, 132, 39, 6, 128)).toEqual([124, 33, 132, 39]);
  });
  it("low zoom across 180°: the whole longitude band, so the Americas are not dropped", () => {
    expect(subscriptionBbox(20, -60, 280, 75, 1.7, 150)).toEqual([-180, -60, 180, 75]);
    expect(subscriptionBbox(-200, -10, -100, 40, 3, -150)).toEqual([-180, -10, 180, 40]);
  });
  it("a view wider than the world is the whole band, latitudes clamped", () => {
    expect(subscriptionBbox(-400, -95, 400, 95, 0, 0)).toEqual([-180, -90, 180, 90]);
  });
  it("zoomed in across 180°: the side holding the view centre (hot region cell comes from the centre)", () => {
    expect(subscriptionBbox(179, -18, 181, -17, 9, 179.6)).toEqual([179, -18, 180, -17]);
    expect(subscriptionBbox(179, -18, 181, -17, 9, 180.4)).toEqual([-180, -18, -179, -17]); // 180.4 = −179.6
    expect(subscriptionBbox(-181, 51, -179, 52, 8, -179.5)).toEqual([-180, 51, -179, 52]);
  });
  it("views shifted by whole turns are normalised", () => {
    expect(subscriptionBbox(484, 33, 492, 39, 6, 488)).toEqual([124, 33, 132, 39]);
  });
});
