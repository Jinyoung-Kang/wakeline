"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { installErrorReporter } from "@/lib/errorReport";
import { AircraftSearch } from "./AircraftSearch";
import { AttributionFooter } from "./AttributionFooter";

const NAV = [
  { href: "/", label: "상황판" },
  { href: "/replay", label: "재생" },
  { href: "/stats", label: "통계" },
  { href: "/ops", label: "운영" },
  { href: "/logs", label: "로그" },
  { href: "/about", label: "출처·한계" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "";
  // 처리되지 않은 브라우저 오류를 시스템 로그로(계약 v5 §C8) — 모든 화면이 이 셸 안에 있다
  useEffect(() => installErrorReporter(), []);
  // 건너뛰기 링크(R-30): Tab 첫 정지점. 상황판은 지도 조작·출처 링크를 건너 알림 패널로 바로 갈 수 있다.
  return (
    <div className="flex h-full flex-col">
      <div className="absolute top-0 left-0 z-50 flex gap-1">
        <a href="#main" className="skip-link">본문으로 건너뛰기</a>
        {path === "/" ? <a href="#side-panel" className="skip-link">알림 목록으로 건너뛰기</a> : null}
      </div>
      {/* 좁은 화면: 줄바꿈(검색은 다음 줄) · 메뉴는 가로 스크롤 — 헤더 밖으로 잘리지 않게(R-39) */}
      <header className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-bg-1 px-3 py-1">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          {/* 미리 가져오기 끔: 모든 화면이 동적 경로(ƒ)라 미리 가져오기마다 서버 렌더가 돌고, edge 의 IP당 양동이(/api/ 와 공유)를 먼저 쓴다 — E2E 429(VERIFICATION #30) */}
          <Link href="/" prefetch={false} className="flex shrink-0 items-baseline gap-2">
            <span className="text-sm font-semibold tracking-[0.2em]">WAKELINE</span>
            <span className="label hidden lg:inline">Aircraft · Ships · Hazardous Weather</span>
          </Link>
          <nav className="flex min-w-0 gap-1 overflow-x-auto" aria-label="주 메뉴">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} prefetch={false} className="btn" aria-current={path === n.href || (n.href !== "/" && path.startsWith(n.href)) ? "page" : undefined}>
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
      <main id="main" tabIndex={-1} className="min-h-0 flex-1 outline-none">{children}</main>
      <AttributionFooter />
    </div>
  );
}
