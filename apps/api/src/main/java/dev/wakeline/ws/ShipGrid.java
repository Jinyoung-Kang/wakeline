package dev.wakeline.ws;

import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.ShipCategory;
import dev.wakeline.ingest.ShipStore;

import java.util.HashMap;
import java.util.Map;

/**
 * 선박 격자 집계(계약 v2 §B3 ships_grid) — ShipStore 버전 하나에 대해 세 단계(5° · 2° · 0.5°)를 <b>한 번의 순회</b>(O(선박 수))로 만든다.
 * 세션마다 다시 세지 않는다: 세션은 만들어진 칸 목록에서 자기 bbox 와 겹치는 칸만 골라 미리 직렬화한 조각을 이어 붙인다.
 * 칸은 에포크처럼 고정된 격자(남서 모서리 −90°/−180° 기준)이고 좌표는 칸 중심이다. 대표 분류는 칸 안에서 가장 많은 {@link ShipCategory}
 * (동률이면 열거 순서의 앞 — 결정적, web 과 같은 순서). 칸 수는 선박이 있는 칸뿐이다(0척 칸 없음).
 * 계약 v5 §B2: 칸의 다섯 번째 원소는 선종별 수 [n0..n10] — 순서는 ShipCategory 선언 순서 = schemas/vectors/ship-categories.v1.json
 * (web 이 선종 필터로 칸 수를 다시 센다). 같은 순회에서 이미 세던 배열을 그대로 싣는다(추가 순회 없음).
 */
final class ShipGrid {
    /** 줌 → 칸 크기(계약: z<3 5°, z<5 2°, z<7 0.5°). 상한 초과(capped)는 가장 촘촘한 0.5°. */
    static final double[] LEVELS = {5.0, 2.0, 0.5};

    /** 칸 하나: 남서 모서리·크기(bbox 겹침 판단)와 미리 직렬화한 [lat, lon, count, "category", [선종별 수]]. */
    record Cell(double minLat, double minLon, double deg, int count, ShipCategory dominant, String json) {
        boolean intersects(Bbox b) {
            return minLon <= b.lomax() && minLon + deg >= b.lomin() && minLat <= b.lamax() && minLat + deg >= b.lamin();
        }
    }

    final long version;
    private final Cell[][] levels;

    private ShipGrid(long version, Cell[][] levels) {
        this.version = version;
        this.levels = levels;
    }

    static double cellDegFor(int zoom) {
        if (zoom < 3) return LEVELS[0];
        if (zoom < 5) return LEVELS[1];
        return LEVELS[2];
    }

    static ShipGrid build(ShipStore.View v) {
        int cats = ShipCategory.count();
        @SuppressWarnings("unchecked")
        Map<Long, int[]>[] counts = new Map[LEVELS.length];
        for (int i = 0; i < LEVELS.length; i++) counts[i] = new HashMap<>();
        for (ShipStore.Ship s : v.ships().values()) {
            double lat = s.state().lat(), lon = s.state().lon();
            int cat = s.category().ordinal();
            for (int i = 0; i < LEVELS.length; i++) counts[i].computeIfAbsent(key(lat, lon, LEVELS[i]), k -> new int[cats])[cat]++;
        }
        Cell[][] levels = new Cell[LEVELS.length][];
        for (int i = 0; i < LEVELS.length; i++) {
            double deg = LEVELS[i];
            long cols = cols(deg);
            Long[] keys = counts[i].keySet().toArray(Long[]::new);
            java.util.Arrays.sort(keys); // 결정적 순서(남 → 북, 서 → 동)
            Cell[] cells = new Cell[keys.length];
            for (int j = 0; j < keys.length; j++) {
                int[] c = counts[i].get(keys[j]);
                int total = 0, best = 0;
                for (int k = 0; k < c.length; k++) {
                    total += c[k];
                    if (c[k] > c[best]) best = k;
                }
                double minLat = -90 + (keys[j] / cols) * deg, minLon = -180 + (keys[j] % cols) * deg;
                ShipCategory dom = ShipCategory.at(best);
                StringBuilder json = new StringBuilder(48 + 3 * c.length).append('[').append(minLat + deg / 2).append(',').append(minLon + deg / 2)
                        .append(',').append(total).append(",\"").append(dom.key()).append("\",[");
                for (int k = 0; k < c.length; k++) {
                    if (k > 0) json.append(',');
                    json.append(c[k]);
                }
                cells[j] = new Cell(minLat, minLon, deg, total, dom, json.append("]]").toString());
            }
            levels[i] = cells;
        }
        return new ShipGrid(v.version(), levels);
    }

    private static long cols(double deg) { return (long) Math.ceil(360 / deg); }

    private static long rows(double deg) { return (long) Math.ceil(180 / deg); }

    static long key(double lat, double lon, double deg) {
        long row = Math.min(rows(deg) - 1, Math.max(0, (long) Math.floor((lat + 90) / deg)));
        long col = Math.min(cols(deg) - 1, Math.max(0, (long) Math.floor((lon + 180) / deg)));
        return row * cols(deg) + col;
    }

    Cell[] cells(double deg) {
        for (int i = 0; i < LEVELS.length; i++) if (LEVELS[i] == deg) return levels[i];
        throw new IllegalArgumentException("no grid level " + deg);
    }

    /** bbox 와 겹치는 칸의 JSON 배열(세션별 — 칸 목록을 거르기만 한다). */
    String cellsJson(double deg, Bbox b) {
        Cell[] cells = cells(deg);
        StringBuilder sb = new StringBuilder(64 + Math.min(cells.length, 4096) * 24).append('[');
        boolean first = true;
        for (Cell c : cells) {
            if (!c.intersects(b)) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append(c.json());
        }
        return sb.append(']').toString();
    }
}
