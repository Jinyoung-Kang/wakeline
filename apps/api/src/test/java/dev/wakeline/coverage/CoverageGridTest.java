package dev.wakeline.coverage;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 관측 수신 격자(ADR-027): 0.5° 칸 · 시 단위 칸(지금 시 + 앞선 24 시)의 선박 수(서로 다른 MMSI) · 위치 수 · 마지막 시각, 창 밖으로 나간 시의 정리,
 * 메모리 상한(칸 · 칸별 선박)과 그 셈. 시계는 시험이 준다.
 */
class CoverageGridTest {
    static final long H = CoverageGrid.HOUR_MS;
    /** 2026-09-30 09:00:00Z — 시 경계 */
    static final long T0 = Instant.parse("2026-09-30T09:00:00Z").toEpochMilli();

    static CoverageGrid grid(long now) { return new CoverageGrid(100, 1_000, now); }

    @Test
    void cellsAreHalfDegreeFloorsOfLonLat_andCountDistinctShipsAndPositions() {
        CoverageGrid g = grid(T0 + 10 * 60_000);
        assertThat(g.add(440_000_001, 37.46, 126.44, T0 + 60_000)).isEqualTo(CoverageGrid.Result.ADDED);
        g.add(440_000_001, 37.47, 126.45, T0 + 120_000); // 같은 선박 · 같은 칸
        g.add(440_000_002, 37.10, 126.01, T0 + 180_000); // 다른 선박 · 같은 칸(37.0–37.5 N · 126.0–126.5 E)
        g.add(440_000_002, -33.9, -151.2, T0 + 180_000); // 남반구 · 서경 — 내림(floor)이라 −34.0 · −151.5
        List<CoverageGrid.CellView> cells = g.cells();
        assertThat(cells).hasSize(2);
        CoverageGrid.CellView seoul = cells.stream().filter(c -> c.lat0() == 37.0).findFirst().orElseThrow();
        assertThat(seoul.lon0()).isEqualTo(126.0);
        assertThat(seoul.ships()).isEqualTo(2);
        assertThat(seoul.positions()).isEqualTo(3);
        assertThat(seoul.lastSeenMs()).isEqualTo(T0 + 180_000);
        CoverageGrid.CellView south = cells.stream().filter(c -> c.lat0() < 0).findFirst().orElseThrow();
        assertThat(south.lat0()).isEqualTo(-34.0);
        assertThat(south.lon0()).isEqualTo(-151.5);
        assertThat(g.cellCount()).isEqualTo(2);
        assertThat(g.shipCells()).isEqualTo(3);
        assertThat(g.positions()).isEqualTo(4);
    }

    @Test
    void theEdgesOfTheWorldFallInTheLastCell_notOutside() {
        CoverageGrid g = grid(T0);
        g.add(1, 90.0, 180.0, T0);
        g.add(2, -90.0, -180.0, T0);
        assertThat(g.cells()).extracting(CoverageGrid.CellView::lon0, CoverageGrid.CellView::lat0)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(-180.0, -90.0), org.assertj.core.groups.Tuple.tuple(179.5, 89.5));
    }

    @Test
    void cellsAreListedInAStableOrder_southToNorthThenWestToEast() {
        CoverageGrid g = grid(T0);
        g.add(1, 10.2, 20.2, T0);
        g.add(1, 10.2, -20.2, T0);
        g.add(1, -10.2, 20.2, T0);
        assertThat(g.cells()).extracting(CoverageGrid.CellView::lat0, CoverageGrid.CellView::lon0).containsExactly(
                org.assertj.core.groups.Tuple.tuple(-10.5, 20.0), org.assertj.core.groups.Tuple.tuple(10.0, -20.5), org.assertj.core.groups.Tuple.tuple(10.0, 20.0));
    }

    @Test
    void theWindowIsTheCurrentHourPlusTheTwentyFourBefore_andOlderReportsAreNotCounted() {
        long now = T0 + 30 * 60_000; // 09:30
        CoverageGrid g = grid(now);
        assertThat(g.windowFromMs()).as("the oldest bucket starts 24 h before the start of the current hour").isEqualTo(T0 - 24 * H);
        assertThat(g.add(7, 1, 1, T0 - 24 * H)).isEqualTo(CoverageGrid.Result.ADDED); // 창의 첫 순간
        assertThat(g.add(7, 1, 1, T0 - 24 * H - 1)).isEqualTo(CoverageGrid.Result.OUTSIDE_WINDOW);
        assertThat(g.positions()).isEqualTo(1);
    }

    @Test
    void rollingForwardDropsHoursThatLeaveTheWindow_shipsKeepTheirNewestHour() {
        CoverageGrid g = grid(T0);
        g.add(1, 37.2, 126.2, T0 - 24 * H + 1);          // 가장 오래된 시
        g.add(2, 37.2, 126.2, T0 - 24 * H + 2);          // 같은 시, 다른 선박
        g.add(2, 37.2, 126.2, T0 - 2 * H);               // 선박 2 는 뒤에도 보고했다
        g.add(3, 50.2, 1.2, T0 - 24 * H + 3);            // 다른 칸 — 그 시에만
        assertThat(g.cellCount()).isEqualTo(2);
        g.roll(T0 + H); // 한 시 앞으로 — 가장 오래된 시가 창 밖으로
        List<CoverageGrid.CellView> cells = g.cells();
        assertThat(cells).as("the cell with only the old hour is gone").hasSize(1);
        assertThat(cells.getFirst().ships()).as("ship 1 left the window, ship 2 stays with its newer report").isEqualTo(1);
        assertThat(cells.getFirst().positions()).isEqualTo(1);
        assertThat(g.shipCells()).isEqualTo(1);
        assertThat(g.positions()).isEqualTo(1);
        g.roll(T0 + 30 * H); // 창을 모두 지나면 비었다
        assertThat(g.cells()).isEmpty();
        assertThat(g.shipCells()).isZero();
        assertThat(g.cellCount()).isZero();
    }

    @Test
    void rollNeverGoesBackward_andAReportAheadOfTheClockCountsInTheCurrentHour() {
        CoverageGrid g = grid(T0 + 59 * 60_000); // 09:59
        g.roll(T0 - 5 * H); // 시계가 뒤로 — 무시
        assertThat(g.windowFromMs()).isEqualTo(T0 - 24 * H);
        // 수집기 시계가 조금 빠르면 10:01 보고가 09:59 에 온다 — 지금 시에 세고, 마지막 시각은 받은 값 그대로
        assertThat(g.add(9, 1, 1, T0 + H + 60_000)).isEqualTo(CoverageGrid.Result.ADDED);
        g.roll(T0 + H + 60_000);
        g.roll(T0 + 25 * H - 1); // 09 시가 가장 오래된 시로 남는 마지막 순간
        assertThat(g.cells()).hasSize(1);
        assertThat(g.cells().getFirst().lastSeenMs()).isEqualTo(T0 + H + 60_000);
        g.roll(T0 + 25 * H);
        assertThat(g.cells()).isEmpty();
    }

    @Test
    void bootstrapRowsLandInTheirCellAndHour_andMergeWithLiveReportsWithoutLosingTheNewest() {
        CoverageGrid g = grid(T0 + 10 * 60_000);
        // 부트스트랩 행: 칸 색인(floor(lon/0.5) · floor(lat/0.5)) · 그 시 · 위치 수 · 마지막 시각
        assertThat(g.addCell(252, 74, 440_000_001, T0 / H - 3, 12, T0 - 3 * H + 1_800_000)).isEqualTo(CoverageGrid.Result.ADDED);
        g.add(440_000_001, 37.2, 126.2, T0 + 60_000); // 같은 칸(126.0 · 37.0) — 실시간
        g.addCell(252, 74, 440_000_001, T0 / H - 5, 3, T0 - 5 * H + 60_000); // 더 오래된 시가 늦게 와도 마지막 시각 · 시를 되돌리지 않는다
        CoverageGrid.CellView c = g.cells().getFirst();
        assertThat(c.lon0()).isEqualTo(126.0);
        assertThat(c.lat0()).isEqualTo(37.0);
        assertThat(c.ships()).isEqualTo(1);
        assertThat(c.positions()).isEqualTo(16);
        assertThat(c.lastSeenMs()).isEqualTo(T0 + 60_000);
        g.roll(T0 + 22 * H + 10 * 60_000); // 창이 07 시부터 — 04 · 06 시 행은 창 밖, 실시간 보고(09 시)는 남는다
        assertThat(g.cells().getFirst().positions()).isEqualTo(1);
        assertThat(g.addCell(252, 74, 5, T0 / H - 30, 1, T0 - 30 * H)).isEqualTo(CoverageGrid.Result.OUTSIDE_WINDOW);
    }

    @Test
    void outOfRangeCellIndicesAreClampedLikeCoordinates() {
        CoverageGrid g = grid(T0);
        g.addCell(360, 180, 1, T0 / H, 1, T0); // 180°E · 90°N 의 floor → 마지막 칸
        g.addCell(-361, -181, 2, T0 / H, 1, T0);
        assertThat(g.cells()).extracting(CoverageGrid.CellView::lon0).containsExactly(-180.0, 179.5);
    }

    @Test
    void theCellCapDropsNewCellsAndCountsTheirPositionsUntilTheyLeaveTheWindow() {
        CoverageGrid g = new CoverageGrid(2, 1_000, T0);
        g.add(1, 1.1, 1.1, T0);
        g.add(1, 2.1, 2.1, T0);
        assertThat(g.add(1, 3.1, 3.1, T0)).isEqualTo(CoverageGrid.Result.DROPPED_CELLS);
        assertThat(g.add(2, 1.1, 1.1, T0)).as("existing cells still take new ships").isEqualTo(CoverageGrid.Result.ADDED);
        assertThat(g.addCell(20, 20, 3, T0 / H, 5, T0)).isEqualTo(CoverageGrid.Result.DROPPED_CELLS);
        assertThat(g.cellCount()).isEqualTo(2);
        assertThat(g.dropped()).isEqualTo(6);
        g.roll(T0 + 25 * H);
        assertThat(g.dropped()).as("drops roll off with their hour").isZero();
    }

    @Test
    void theShipCellCapDropsNewShipsInACell_butKeepsCountingKnownShips() {
        CoverageGrid g = new CoverageGrid(100, 2, T0);
        g.add(1, 1.1, 1.1, T0);
        g.add(2, 1.1, 1.1, T0);
        assertThat(g.add(3, 1.1, 1.1, T0)).isEqualTo(CoverageGrid.Result.DROPPED_SHIP_CELLS);
        assertThat(g.add(3, 9.1, 9.1, T0)).as("no new cell for a ship that cannot be recorded").isEqualTo(CoverageGrid.Result.DROPPED_SHIP_CELLS);
        assertThat(g.cellCount()).isEqualTo(1);
        assertThat(g.add(1, 1.2, 1.2, T0 + 1)).isEqualTo(CoverageGrid.Result.ADDED);
        assertThat(g.cells().getFirst().positions()).isEqualTo(3);
        assertThat(g.dropped()).isEqualTo(2);
        assertThat(g.shipCells()).isEqualTo(2);
    }

    @Test
    void theMemoryBoundFormulaIsTheSumOfTheCaps_arithmeticOnly() {
        // 셈만 본다(ADR-027 — 칸 하나 · 칸별 선박 하나의 바이트 상한을 곱한 합). 그 바이트 값이 실제 객체 크기를 덮는지는 아래 잰 시험이 본다
        long b = CoverageGrid.memoryBoundBytes(16_000, 200_000);
        assertThat(b).isEqualTo(16_000L * CoverageGrid.CELL_BYTES_MAX + 200_000L * CoverageGrid.SHIP_CELL_BYTES_MAX);
        assertThat(b).isLessThan(16L * 1024 * 1024);
    }

    /**
     * 리뷰(2026-09-30): 위 시험은 식을 식과 견줄 뿐이라 실패할 수 없었다 — 칸 512 B · 칸별 선박 32 B 라는 ADR-027 의 값이 실제 객체 크기를 덮는지는 아무도 보지
     * 않았다(Cell 에 필드를 늘려도 모른다). 여기서는 격자를 채운 뒤 GC 뒤 힙 사용량의 차이(남아 있는 바이트)를 재어 상한과 견준다. 모양 둘: 칸마다 선박 1(칸 쪽이 큼) ·
     * 칸마다 선박 5(MMSI 표가 8 → 16 칸으로 넓어진 직후 — 칸별 선박 쪽이 큼). 잡음(다른 스레드)은 세 번 재어 가장 작은 값으로 줄이고, 잰 값이 격자를 보았는지
     * (상한의 1/4 이상)도 본다. JOL 은 새 의존성이라 쓰지 않았다.
     */
    @Test
    void theMemoryBoundCoversTheMeasuredRetainedHeap() {
        org.junit.jupiter.api.Assumptions.assumeFalse(java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments().stream()
                .anyMatch(a -> a.contains("DisableExplicitGC")), "explicit GC is disabled — the heap cannot be measured");
        for (int perCell : new int[]{1, 5}) {
            int cellCount = 8_000;
            long retained = Long.MAX_VALUE;
            for (int attempt = 0; attempt < 3; attempt++) {
                long before = usedAfterGc();
                CoverageGrid g = filled(cellCount, perCell);
                long after = usedAfterGc();
                assertThat(g.cellCount()).isEqualTo(cellCount);
                assertThat(g.shipCells()).isEqualTo(cellCount * perCell);
                retained = Math.min(retained, after - before);
                java.lang.ref.Reference.reachabilityFence(g);
            }
            long bound = CoverageGrid.memoryBoundBytes(cellCount, cellCount * perCell);
            assertThat(retained).as("%d ships per cell: retained %d B vs bound %d B", perCell, retained, bound).isLessThanOrEqualTo(bound);
            assertThat(retained).as("the measurement saw the grid").isGreaterThan(bound / 4);
        }
    }

    /** 서로 다른 칸 cellCount 개(위도 띠를 따라) · 칸마다 서로 다른 선박 perCell 척 — 상한은 넉넉히(넘치지 않게). */
    private static CoverageGrid filled(int cellCount, int perCell) {
        CoverageGrid g = new CoverageGrid(cellCount, cellCount * perCell, T0);
        for (int i = 0; i < cellCount; i++) {
            int lonIdx = i % CoverageGrid.LON_CELLS - CoverageGrid.LON_CELLS / 2, latIdx = i / CoverageGrid.LON_CELLS;
            for (int k = 0; k < perCell; k++) g.addCell(lonIdx, latIdx, 200_000_000 + i * perCell + k, Math.floorDiv(T0, H), 1, T0);
        }
        return g;
    }

    private static long usedAfterGc() {
        java.lang.management.MemoryMXBean m = java.lang.management.ManagementFactory.getMemoryMXBean();
        for (int i = 0; i < 3; i++) System.gc();
        return m.getHeapMemoryUsage().getUsed();
    }
}
