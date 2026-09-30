package dev.wakeline.coverage;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 관측 AIS 수신 격자(ADR-027 · 계약 v5 §G27): 이 서비스가 실제로 받은 선박 위치를 0.5° 칸 · 시 단위로 센다. 구독 범위(운영 설정 ais_bboxes)가 아니라
 * '어디서 위치가 왔는가'다 — aisstream.io 는 육상 AIS 수신국이 받은 것만 보내므로 수신국이 없는 해역은 구독해도 비어 있다.
 * <ul>
 *   <li>칸: 경도 · 위도를 {@value #CELL_DEG}° 로 내림(floor) — 칸 [lon0, lon0 + 0.5) × [lat0, lat0 + 0.5). 180°E · 90°N 은 마지막 칸(범위 안으로 붙인다).
 *       0.5° 는 고른 값이다(잰 값 아님 — 근거는 ADR-027).</li>
 *   <li>창: 시(에포크 시) 칸 {@value #BUCKETS}개 = 지금 시(진행 중) + 앞선 {@value #WINDOW_H} 시. 창의 시작 = 지금 시의 시작 − 24 h — 늘 최근 24 h 이상(24–25 h).
 *       시계가 다음 시로 넘어가면({@link #roll}) 창 밖으로 나간 시를 비운다. 시계는 되돌아가지 않는다.</li>
 *   <li>칸마다: 시별 위치 수 · 시별 '그 시가 마지막 보고인 선박 수'(선박 수 = 창 안 서로 다른 MMSI) · MMSI → 마지막 시 표 · 가장 늦은 위치 시각.
 *       위치 수는 받은 표본 그대로다(부르는 쪽이 저장과 같은 60 s 창마다 첫 보고로 준다 — ShipCoverage).</li>
 *   <li>지금 시보다 뒤인 보고(수집기 시계가 조금 빠름 — 부르는 쪽이 5분 넘게 미래인 것은 버린다)는 지금 시에 센다. 마지막 시각은 받은 값 그대로.</li>
 *   <li>메모리 상한: 칸 수 · 칸별 선박 항목 수. 넘으면 그 보고를 세지 않고 그 시의 '빠진 위치'로 센다({@link #dropped} — 창 밖으로 나가면 함께 빠진다).
 *       한 보고를 칸에는 넣고 선박에는 넣지 않는 일은 없다(선박 수 ≤ 위치 수가 늘 맞다). 상한의 바이트 계산은 {@link #memoryBoundBytes}.</li>
 * </ul>
 * 스레드 안전하지 않다 — 주인(ShipCoverage)이 잠금 하나로 부른다.
 */
public final class CoverageGrid {
    public static final double CELL_DEG = 0.5;
    /** 1° 안의 칸 수(1 / CELL_DEG — 2의 거듭제곱 분수라 곱이 정확하다: DB 의 floor(ST_X · 2) 와 같은 값). */
    public static final int CELLS_PER_DEG = 2;
    public static final int WINDOW_H = 24;
    public static final int BUCKETS = WINDOW_H + 1;
    public static final long HOUR_MS = 3_600_000L;
    static final int LON_CELLS = 360 * CELLS_PER_DEG;
    static final int LAT_CELLS = 180 * CELLS_PER_DEG;
    /**
     * 칸 하나의 바이트 상한(계산 — 64 비트 JVM · 압축 포인터 · 8 B 정렬): 칸 객체 32 + 시별 int[25] 둘 240 + MMSI 표 객체 32 + 처음 배열(int[8] 둘) 96 +
     * HashMap 항목 32 · 칸 번호 Integer 16 · 표 칸 8 = 456 → 512 로 둔다.
     */
    static final long CELL_BYTES_MAX = 512;
    /** 칸별 선박 항목 하나의 바이트 상한: 키 · 값 int(8 B)에 채움 1/4 이상(1/2 에서 넓힌다) → 32. */
    static final long SHIP_CELL_BYTES_MAX = 32;

    /** 보고 하나의 결과. */
    public enum Result { ADDED, OUTSIDE_WINDOW, DROPPED_CELLS, DROPPED_SHIP_CELLS }

    /** 칸 하나의 창 안 값. lastSeenMs = 이 칸에서 받은 가장 늦은 위치의 시각(받은 값 그대로). */
    public record CellView(double lon0, double lat0, int ships, int positions, long lastSeenMs) {}

    private static final class Cell {
        final int[] positions = new int[BUCKETS];
        final int[] shipsByLastHour = new int[BUCKETS];
        final IntIntMap lastHour = new IntIntMap();
        long lastSeenMs = Long.MIN_VALUE;
    }

    private final int maxCells;
    private final int maxShipCells;
    private final HashMap<Integer, Cell> cells = new HashMap<>();
    private final long[] droppedByBucket = new long[BUCKETS];
    private long curHour;
    private int shipCells;

    public CoverageGrid(int maxCells, int maxShipCells, long nowMs) {
        if (maxCells < 1 || maxShipCells < 1) throw new IllegalArgumentException("caps must be positive");
        this.maxCells = maxCells;
        this.maxShipCells = maxShipCells;
        this.curHour = Math.floorDiv(nowMs, HOUR_MS);
    }

    /** 바이트 상한(계산값 — 잰 값 아님): 칸 상한 × 칸 바이트 + 칸별 선박 상한 × 항목 바이트. */
    public static long memoryBoundBytes(int maxCells, int maxShipCells) {
        return maxCells * CELL_BYTES_MAX + maxShipCells * SHIP_CELL_BYTES_MAX;
    }

    private static int slot(long hour) { return (int) Math.floorMod(hour, BUCKETS); }

    public long currentHour() { return curHour; }

    /** 창의 시작(가장 오래된 시 칸의 시작, ms). */
    public long windowFromMs() { return (curHour - WINDOW_H) * HOUR_MS; }

    /**
     * 시계를 nowMs 의 시로 옮긴다. 창 밖으로 나간 시(칸마다 위치 · 선박 수 · 빠진 위치)를 비우고, 마지막 보고가 그 시인 선박 항목을 지우고, 빈 칸을 지운다.
     * 앞 시각이면 아무것도 하지 않는다. 드는 일: 칸 수 × 넘어간 시(최대 25) + 칸별 선박 항목 — 한 시에 한 번.
     */
    public void roll(long nowMs) {
        long h = Math.floorDiv(nowMs, HOUR_MS);
        if (h <= curHour) return;
        long steps = Math.min(h - curHour, BUCKETS);
        for (long x = h - steps + 1; x <= h; x++) droppedByBucket[slot(x)] = 0;
        int minHour = (int) (h - WINDOW_H);
        var it = cells.values().iterator();
        while (it.hasNext()) {
            Cell c = it.next();
            for (long x = h - steps + 1; x <= h; x++) {
                c.positions[slot(x)] = 0;
                c.shipsByLastHour[slot(x)] = 0;
            }
            shipCells -= c.lastHour.removeBelow(minHour);
            if (c.lastHour.size() == 0) it.remove();
        }
        curHour = h;
    }

    /** 실시간 위치 한 건(좌표 — 수집기가 검증한 범위). */
    public Result add(int mmsi, double lat, double lon, long seenMs) {
        return record(lonIndex(lon), latIndex(lat), mmsi, Math.floorDiv(seenMs, HOUR_MS), 1, seenMs);
    }

    /**
     * 부트스트랩 행 하나: 칸 색인(floor(lon · 2) · floor(lat · 2) — 범위 밖은 붙인다) · 그 행의 시(에포크 시) · 위치 수 · 그 칸에서 그 선박의 가장 늦은 위치 시각.
     */
    public Result addCell(int lonIdx, int latIdx, int mmsi, long hour, int positions, long lastMs) {
        return record(clamp(lonIdx, -LON_CELLS / 2, LON_CELLS / 2 - 1), clamp(latIdx, -LAT_CELLS / 2, LAT_CELLS / 2 - 1), mmsi, hour, positions, lastMs);
    }

    private Result record(int lonIdx, int latIdx, int mmsi, long hour, int n, long lastMs) {
        if (hour < curHour - WINDOW_H) return Result.OUTSIDE_WINDOW;
        long h = Math.min(hour, curHour);
        int s = slot(h);
        int key = (latIdx + LAT_CELLS / 2) * LON_CELLS + (lonIdx + LON_CELLS / 2);
        Cell c = cells.get(key);
        int prev = c == null ? IntIntMap.MISSING : c.lastHour.get(mmsi);
        if (prev == IntIntMap.MISSING && shipCells >= maxShipCells) {
            droppedByBucket[s] += n;
            return Result.DROPPED_SHIP_CELLS;
        }
        if (c == null) {
            if (cells.size() >= maxCells) {
                droppedByBucket[s] += n;
                return Result.DROPPED_CELLS;
            }
            c = new Cell();
            cells.put(key, c);
        }
        if (prev == IntIntMap.MISSING) {
            c.lastHour.put(mmsi, (int) h);
            c.shipsByLastHour[s]++;
            shipCells++;
        } else if (h > prev) {
            c.lastHour.put(mmsi, (int) h);
            c.shipsByLastHour[slot(prev)]--;
            c.shipsByLastHour[s]++;
        }
        c.positions[s] += n;
        if (lastMs > c.lastSeenMs) c.lastSeenMs = lastMs;
        return Result.ADDED;
    }

    static int lonIndex(double lon) { return clamp((int) Math.floor(lon * CELLS_PER_DEG), -LON_CELLS / 2, LON_CELLS / 2 - 1); }

    static int latIndex(double lat) { return clamp((int) Math.floor(lat * CELLS_PER_DEG), -LAT_CELLS / 2, LAT_CELLS / 2 - 1); }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    /** 창 안 칸 전부 — 남 → 북, 같은 위도 띠에서는 서 → 동(결정적 순서). */
    public List<CellView> cells() {
        List<Map.Entry<Integer, Cell>> es = new ArrayList<>(cells.entrySet());
        es.sort(Map.Entry.comparingByKey());
        List<CellView> out = new ArrayList<>(es.size());
        for (Map.Entry<Integer, Cell> e : es) {
            Cell c = e.getValue();
            int ships = 0, positions = 0;
            for (int i = 0; i < BUCKETS; i++) {
                ships += c.shipsByLastHour[i];
                positions += c.positions[i];
            }
            int latIdx = e.getKey() / LON_CELLS - LAT_CELLS / 2, lonIdx = e.getKey() % LON_CELLS - LON_CELLS / 2;
            out.add(new CellView(lonIdx * CELL_DEG, latIdx * CELL_DEG, ships, positions, c.lastSeenMs));
        }
        return out;
    }

    public int cellCount() { return cells.size(); }

    /** 칸별 선박 항목 수(한 선박이 칸 N 개에서 보고했으면 N). */
    public int shipCells() { return shipCells; }

    /** 창 안 위치 수의 합. */
    public long positions() {
        long n = 0;
        for (Cell c : cells.values()) for (int p : c.positions) n += p;
        return n;
    }

    /** 창 안에서 상한 때문에 세지 못한 위치 수. */
    public long dropped() {
        long n = 0;
        for (long d : droppedByBucket) n += d;
        return n;
    }
}
