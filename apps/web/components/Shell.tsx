"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AircraftSearch } from "./AircraftSearch";
import { AttributionFooter } from "./AttributionFooter";

const NAV = [
  { href: "/", label: "상황판" },
  { href: "/replay", label: "재생" },
  { href: "/stats", label: "통계" },
  { href: "/ops", label: "운영" },
  { href: "/about", label: "출처·한계" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex h-full flex-col">
      {/* 좁은 화면: 줄바꿈(검색은 다음 줄) · 메뉴는 가로 스크롤 — 헤더 밖으로 잘리지 않게(R-39) */}
      <header className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-bg-1 px-3 py-1">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <Link href="/" className="flex shrink-0 items-baseline gap-2">
            <span className="text-sm font-semibold tracking-[0.2em]">WAKELINE</span>
            <span className="label hidden lg:inline">Aircraft · Ships · Hazardous Weather</span>
          </Link>
          <nav className="flex min-w-0 gap-1 overflow-x-auto" aria-label="주 메뉴">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="btn" aria-current={path === n.href || (n.href !== "/" && path.startsWith(n.href)) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {/* 검색 결과로 지도를 옮기므로 상황판에서만 */}
          {path === "/" ? <AircraftSearch /> : null}
          <div className="label hidden xl:block">portfolio · non-commercial · local</div>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <AttributionFooter />
    </div>
  );
}
