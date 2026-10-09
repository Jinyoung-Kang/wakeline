package dev.wakeline.weather.core;

import dev.wakeline.geo.GeoJson;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.geom.prep.PreparedGeometry;
import org.locationtech.jts.geom.prep.PreparedGeometryFactory;
import org.locationtech.jts.index.strtree.STRtree;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * 판정 구역 다각형 R-tree(JTS STRtree, 질의 전용). 구역이 바뀔 때에만 재구축하고 질의는 스레드 안전하다(10.2절). 구역은 {@link Zone} — SIGMET · 공역(ADR-035).
 */
public final class ZoneIndex {
    public record Item(Zone zone, int polygonIndex, Polygon polygon, PreparedGeometry prepared) {
        /** SIGMET 구역이면 그 경보, 아니면 null. */
        public SigmetRecord sigmet() { return zone instanceof SigmetRecord s ? s : null; }
    }

    private final STRtree tree = new STRtree();
    private final int size;
    private final Instant builtAt;

    public ZoneIndex(Collection<? extends Zone> zones, Instant now) {
        int n = 0;
        for (Zone s : zones) {
            if (s.geometry() == null || !s.validTo().isAfter(now)) continue;
            for (int i = 0; i < s.geometry().getNumGeometries(); i++) {
                Polygon p = (Polygon) s.geometry().getGeometryN(i);
                tree.insert(p.getEnvelopeInternal(), new Item(s, i, p, PreparedGeometryFactory.prepare(p)));
                n++;
            }
        }
        tree.build();
        size = n;
        builtAt = now;
    }

    public int size() { return size; }
    public Instant builtAt() { return builtAt; }

    /** 점이 들어 있는(수평) 항목. 고도·유효시간은 호출자가 검사. */
    public List<Item> queryPoint(double lon, double lat) {
        if (size == 0) return List.of();
        Point pt = GeoJson.GF.createPoint(new Coordinate(lon, lat));
        @SuppressWarnings("unchecked")
        List<Item> cands = tree.query(pt.getEnvelopeInternal());
        List<Item> out = new ArrayList<>(2);
        for (Item it : cands) if (it.prepared().intersects(pt)) out.add(it);
        return out;
    }

    public List<Item> queryGeometry(Geometry g) {
        if (size == 0) return List.of();
        Envelope env = g.getEnvelopeInternal();
        @SuppressWarnings("unchecked")
        List<Item> cands = tree.query(env);
        List<Item> out = new ArrayList<>(2);
        for (Item it : cands) if (it.prepared().intersects(g)) out.add(it);
        return out;
    }
}
