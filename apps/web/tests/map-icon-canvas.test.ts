/**
 * 지도 아이콘(항공기 · 선박 SDF)을 그리는 2D 캔버스는 CPU 캔버스다(`willReadFrequently`) — PERF §15.
 * 아이콘은 한 번 그려 getImageData 로 읽어 addImage 에 넘긴다. GPU 캔버스면 읽을 때 GPU → CPU 동기 읽기로 주 스레드가 기다린다:
 * 소프트웨어 GL(SwiftShader — QA-402 의 측정 환경)에서 아이콘 다섯 개가 지도 'load' 의 한 작업 안에서 약 560 ms 를 썼다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { iconCanvas, planeImage, sdfImage, NODIR_PATH } from "@/lib/maplayers";
import { shipCogImage } from "@/lib/ship-layers";

const calls: { kind: string; opts: unknown }[] = [];
const realDocument = globalThis.document;
function fakeDocument() {
  const ctx = new Proxy({ getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : () => {}), set: (t, k: string, v) => { t[k] = v; return true; } });
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => ({ tagName: tag, width: 0, height: 0, getContext: (kind: string, opts?: unknown) => { calls.push({ kind, opts }); return ctx; } }),
  };
  (globalThis as { Path2D?: unknown }).Path2D ??= class { constructor(public d: string) {} };
}
afterEach(() => { calls.length = 0; (globalThis as { document?: unknown }).document = realDocument; });

describe("map icon canvases are CPU canvases (read back once with getImageData)", () => {
  it("every icon image asks for a 2d context with willReadFrequently", () => {
    fakeDocument();
    const imgs = [planeImage(), sdfImage(NODIR_PATH), shipCogImage(), iconCanvas(16).getImageData(0, 0, 16, 16)];
    expect(imgs.map((i) => i.width)).toEqual([48, 48, 48, 16]);
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c).toEqual({ kind: "2d", opts: { willReadFrequently: true } });
  });
});
