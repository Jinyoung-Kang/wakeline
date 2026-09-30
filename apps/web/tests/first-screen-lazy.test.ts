import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 첫 화면 JS(NFR-04, ADR-026): 상황판 `/` 를 처음 열 때 받는 코드에 **상호작용 뒤에만 보이는 화면**을 싣지 않는다.
 * `/` 의 첫 로드는 루트 레이아웃(Shell · 통합 검색) · 페이지 · 두 오류 경계에서 정적으로 닿는 모듈 전부다(Next 가 청크로 묶어 HTML 에 싣는다).
 * 아래 모듈은 클릭 · 탭 · 펼치기 · 검색 뒤에만 그려지므로 import() 로 불러와야 한다(components/DashboardParts.tsx — 받는 동안 진행 표시, 실패하면 다시 시도).
 */
const ROOT = resolve(__dirname, "..");
const FIRST_SCREEN_ROOTS = ["app/layout.tsx", "app/page.tsx", "app/error.tsx", "app/global-error.tsx"];

/** 첫 화면 밖으로 뺀 화면과 그 까닭(언제 보이는가) */
const INTERACTION_ONLY: Record<string, string> = {
  "components/AircraftCard.tsx": "지도 · 알림 · 검색에서 항공기를 고른 뒤(aircraft 탭)",
  "components/ShipCard.tsx": "선박 탭 · 선박을 고른 뒤",
  "components/PortCallsSection.tsx": "선박 카드 안",
  "components/SigmetCard.tsx": "SIGMET 을 고른 뒤",
  "components/SigmetList.tsx": "SIGMET 탭",
  "components/AirportCard.tsx": "공항을 고른 뒤",
  "components/AirportList.tsx": "공항 탭",
  "components/EvidenceCard.tsx": "알림 행을 펼친 뒤 · 항공기 카드 안",
  "components/KrRadarPanel.tsx": "레이더 줄의 '범례·정합' 단추",
  "components/ShipTable.tsx": "통합 검색 결과(선박) · 선박 카드 안",
};

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null; // 패키지
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + ext) && (ext || /\.(ts|tsx)$/.test(base))) return base + ext;
  return null;
}

/** 정적 import · re-export 만 따라간다(import type 은 실행 코드가 아니다 · import() 는 따로 받는 청크다) */
function staticGraph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entries.map((e) => resolve(ROOT, e));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"';]*?from\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const r = resolveImport(f, m[1] ?? m[2]);
      if (r && !r.endsWith(".css")) stack.push(r);
    }
  }
  return seen;
}
const rel = (f: string) => f.slice(ROOT.length + 1);

/** 그래프 파일 안의 import("./X") · import("@/…") 대상(나중에 받는 조각의 뿌리) */
function dynamicTargets(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const abs = resolve(ROOT, f);
    for (const m of readFileSync(abs, "utf8").matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      const r = resolveImport(abs, m[1]);
      if (r) out.add(rel(r));
    }
  }
  return [...out];
}

describe("first screen of '/' carries no interaction-only UI", () => {
  const graph = [...staticGraph(FIRST_SCREEN_ROOTS)].map(rel);
  const lazyGraph = [...staticGraph(dynamicTargets(graph))].map(rel);
  it("the static graph is the real one (sanity: the dashboard pieces are in it)", () => {
    for (const f of ["components/Shell.tsx", "components/SidePanel.tsx", "components/AlertPanel.tsx", "components/StatusBar.tsx", "components/RadarTimeline.tsx", "components/LayerPanel.tsx", "lib/ships.ts"]) {
      expect(graph).toContain(f);
    }
  });
  for (const [mod, when] of Object.entries(INTERACTION_ONLY)) {
    it(`${mod} (${when}) is not statically reachable — it is loaded on demand`, () => {
      expect(graph).not.toContain(mod);
      // 여전히 쓸 수 있다: 첫 화면 모듈이 import() 로 부르는 조각(과 그 조각이 정적으로 싣는 모듈) 안에 있다
      expect(lazyGraph).toContain(mod);
    });
  }
  it("next/dynamic on the first screen is only the map (the build-output guard counts next/dynamic chunks of '/' as first-render JS)", () => {
    const users = graph.filter((f) => /from\s+["']next\/dynamic["']/.test(readFileSync(resolve(ROOT, f), "utf8")));
    expect(users).toEqual(["app/page.tsx"]);
    const page = readFileSync(resolve(ROOT, "app/page.tsx"), "utf8");
    expect(page.match(/\bdynamic\(/g)?.length).toBe(1);
    expect(page).toMatch(/dynamic\(\(\) => Promise\.all\(\[import\("@\/components\/MapView"\)/);
  });
});
