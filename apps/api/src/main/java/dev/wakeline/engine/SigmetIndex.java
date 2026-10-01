package dev.wakeline.engine;

import dev.wakeline.geo.GeoJson;
import dev.wakeline.domain.SigmetRecord;
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

/** SIGMET 폴리곤 R-tree(JTS STRtree, 질의 전용). SIGMET 갱신 시에만 재구축하고 질의는 스레드 안전하다(10.2절). */
public final class SigmetIndex {
    public record Item(SigmetRecord sigmet, int polygonIndex, Polygon polygon, PreparedGeometry prepared) {}

    private final STRtree tree = new STRtree();
    private final int size;
    private final Instant builtAt;

    public SigmetIndex(Collection<SigmetRecord> sigmets, Instant now) {
        int n = 0;
        for (SigmetRecord s : sigmets) {
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
