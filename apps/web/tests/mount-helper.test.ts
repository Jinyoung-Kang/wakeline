// tests/helpers/mount.ts 자체 시험 — 마운트 · 다시 그리기 · 언마운트, StrictMode 의 이중 효과, 처리기 부르기
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(() => m.unmount());

const log: string[] = [];
function Probe({ label }: { label: string }) {
  const React = m.React;
  const [n, setN] = React.useState(0);
  React.useEffect(() => { log.push(`mount ${label}`); return () => { log.push(`cleanup ${label}`); }; }, [label]);
  return React.createElement("button", { "data-testid": "probe", onClick: () => setN((x) => x + 1) }, `${label} ${n}`);
}

describe("tests/helpers/mount", () => {
  it("renders, re-renders with new props on the same root, clicks through React props and unmounts", async () => {
    log.length = 0;
    await m.render(m.React.createElement(Probe, { label: "a" }));
    expect(m.byTestId("probe")!.textContent).toBe("a 0");
    await m.click(m.button("a 0"));
    expect(m.byTestId("probe")!.textContent).toBe("a 1");
    await m.render(m.React.createElement(Probe, { label: "b" }));
    expect(m.byTestId("probe")!.textContent).toBe("b 1");
    await m.unmount();
    expect(m.byTestId("probe")).toBeNull();
    expect(log).toEqual(["mount a", "cleanup a", "mount b", "cleanup b"]);
  });

  it("strict mounts run effects mount → cleanup → mount, as next dev does", async () => {
    log.length = 0;
    await m.render(m.React.createElement(Probe, { label: "s" }), { strict: true });
    expect(log).toEqual(["mount s", "cleanup s", "mount s"]);
  });
});

describe("tests/helpers/mini-dom prints in a failing expectation", () => {
  it("a failing expect on an element reports the element, not a TypeError from the printer", () => {
    const el = dom.document.createElement("div");
    el.setAttribute("data-testid", "x");
    const span = dom.document.createElement("span");
    span.appendChild(dom.document.createTextNode("hello"));
    el.appendChild(span);
    expect(() => expect(el).toBeNull()).toThrow(/expected <div data-testid="x">.*<\/div> to be null/);
  });
});
