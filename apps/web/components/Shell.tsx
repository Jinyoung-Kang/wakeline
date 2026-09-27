"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-bg-1 px-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-[0.2em]">SKYWX</span>
            <span className="label hidden sm:inline">Aircraft · Hazardous Weather</span>
          </Link>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="btn" aria-pressed={path === n.href || (n.href !== "/" && path.startsWith(n.href))}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="label hidden md:block">portfolio · non-commercial · local</div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
