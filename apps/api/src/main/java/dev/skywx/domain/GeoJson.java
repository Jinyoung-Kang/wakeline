package dev.skywx.domain;

import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.LinearRing;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.geom.PrecisionModel;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/** GeoJSON MultiPolygon ↔ JTS 변환(외부 라이브러리 없이 필요한 만큼만). */
public final class GeoJson {
    public static final GeometryFactory GF = new GeometryFactory(new PrecisionModel(), 4326);

    private GeoJson() {}

    public static MultiPolygon toMultiPolygon(JsonNode geometry) {
        if (geometry == null || geometry.isNull() || !"MultiPolygon".equals(geometry.path("type").asString())) return null;
        List<Polygon> polys = new ArrayList<>();
        for (JsonNode poly : geometry.path("coordinates")) {
            LinearRing shell = null;
            List<LinearRing> holes = new ArrayList<>();
            int r = 0;
            for (JsonNode ring : poly) {
                List<Coordinate> cs = new ArrayList<>();
                for (JsonNode pt : ring) cs.add(new Coordinate(pt.get(0).asDouble(), pt.get(1).asDouble()));
                if (cs.size() < 4) continue;
                if (!cs.getFirst().equals2D(cs.getLast())) cs.add(cs.getFirst());
                LinearRing lr = GF.createLinearRing(cs.toArray(new Coordinate[0]));
                if (r++ == 0) shell = lr; else holes.add(lr);
            }
            if (shell != null) polys.add(GF.createPolygon(shell, holes.toArray(new LinearRing[0])));
        }
        return polys.isEmpty() ? null : GF.createMultiPolygon(polys.toArray(new Polygon[0]));
    }

    /** MultiPolygon → GeoJSON coordinates (List 구조; Jackson 이 그대로 직렬화). */
    public static List<List<List<double[]>>> coordinates(MultiPolygon mp) {
        List<List<List<double[]>>> out = new ArrayList<>();
        for (int i = 0; i < mp.getNumGeometries(); i++) {
            Polygon p = (Polygon) mp.getGeometryN(i);
            List<List<double[]>> rings = new ArrayList<>();
            rings.add(ring(p.getExteriorRing().getCoordinates()));
            for (int h = 0; h < p.getNumInteriorRing(); h++) rings.add(ring(p.getInteriorRingN(h).getCoordinates()));
            out.add(rings);
        }
        return out;
    }

    private static List<double[]> ring(Coordinate[] cs) {
        List<double[]> r = new ArrayList<>(cs.length);
        for (Coordinate c : cs) r.add(new double[]{round(c.x), round(c.y)});
        return r;
    }

    private static double round(double v) { return Math.round(v * 1e5) / 1e5; }
}
