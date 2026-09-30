package dev.wakeline.coverage;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

import java.util.concurrent.atomic.AtomicLong;

/** 다른 패키지의 시험(REST)이 관측 수신 격자를 가짜 시계 · 가짜 DB 로 만든다(패키지 안 생성자를 여는 창구). */
public final class ShipCoverageFixtures {
    private ShipCoverageFixtures() {}

    /** 읽을 행이 없는 DB. */
    public static CoverageSource empty() {
        return () -> new CoverageSource.Session() {
            @Override public void read(long fromMs, long toMs, java.util.function.Consumer<CoverageSource.Row> sink) {}
            @Override public void close() {}
        };
    }

    public static ShipCoverage coverage(AtomicLong clock, CoverageSource src) {
        return coverage(clock, src, ShipCoverage.MAX_CELLS);
    }

    public static ShipCoverage coverage(AtomicLong clock, CoverageSource src, int maxCells) {
        ShipCoverage c = new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, maxCells, ShipCoverage.MAX_SHIP_CELLS);
        c.sleeper = clock::addAndGet; // 다시 읽기 전 기다림 — 가짜 시계를 그만큼 옮긴다
        return c;
    }

    /** 다시 읽기 전 기다림마다 onWait 를 부른 뒤(그 순간의 응답을 본다) 가짜 시계를 그만큼 옮긴다. */
    public static void onRetryWait(ShipCoverage c, AtomicLong clock, Runnable onWait) {
        c.sleeper = ms -> { onWait.run(); clock.addAndGet(ms); };
    }

    /** 부트스트랩을 부르는 스레드에서 한 번. */
    public static void bootstrap(ShipCoverage c) { c.runBootstrap(); }
}
