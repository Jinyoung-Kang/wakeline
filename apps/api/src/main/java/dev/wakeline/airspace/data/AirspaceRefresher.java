package dev.wakeline.airspace.data;

import dev.wakeline.airspace.core.AirspaceEdition;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.core.AirspaceZones;
import dev.wakeline.platform.data.Sql;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.io.ParseException;
import org.locationtech.jts.io.WKBReader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 켜진 공역 차수를 60 s 마다 확인하고, 바뀌었을 때만 도형을 다시 읽어 {@link AirspaceStore} 를 통째로 바꾼다(ADR-034).
 * 가져오기(수집기의 1회성 명령)는 한 트랜잭션으로 새 차수를 켜므로 반쯤 들어간 차수를 읽지 않는다. 읽기가 실패하면(DB 장애) 이전 스냅숏을 둔다 —
 * 공역은 자주 바뀌지 않는다. 차수가 꺼져 없어지면(운영자가 migrator 로 끔) 빈 스냅숏으로 바꾼다.
 * 같은 주기에 운영 설정 airspace_alerts(off · shadow · on — ADR-035)를 읽어 판정 구역 공급원({@link AirspaceZones})에 넘긴다 — /ops 에서 바꾸면
 * 60 s 안에 따른다. 읽지 못하면 이전 값을 둔다(기본 shadow).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class AirspaceRefresher {
    private static final Logger log = LoggerFactory.getLogger(AirspaceRefresher.class);
    private final JdbcClient db;
    private final AirspaceStore store;
    private final ObjectMapper json;
    private final AirspaceZones zones;
    private volatile boolean warned;

    public AirspaceRefresher(JdbcClient db, AirspaceStore store, ObjectMapper json, AirspaceZones zones) {
        this.db = db;
        this.store = store;
        this.json = json;
        this.zones = zones;
    }

    @Scheduled(initialDelay = 2_000, fixedDelay = 60_000)
    public void refresh() {
        try {
            db.sql("SELECT value #>> '{}' FROM app_setting WHERE key = 'airspace_alerts'").query(String.class).optional().ifPresent(m -> {
                if (!m.equals(zones.mode())) log.info("airspace alerts mode: {} (was {})", m, zones.mode());
                zones.setMode(m);
            });
            AirspaceEdition ed = db.sql("SELECT id, label, document_name, source_sha256, imported_at FROM airspace_edition WHERE active")
                    .query((rs, i) -> new AirspaceEdition(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), Sql.toInstant(rs.getObject(5))))
                    .optional().orElse(null);
            AirspaceStore.Snapshot cur = store.snapshot();
            boolean same = ed == null ? cur.edition() == null : cur.edition() != null && cur.edition().id() == ed.id();
            if (same) return;
            AirspaceStore.Snapshot next = ed == null ? AirspaceStore.Snapshot.EMPTY : new AirspaceStore.Snapshot(ed, load(ed.id()));
            store.replace(next);
            warned = false;
            log.info("airspace edition {} active — {} records", ed == null ? "none" : ed.label() + " (id " + ed.id() + ")", next.records().size());
        } catch (RuntimeException e) {
            if (!warned) log.warn("airspace refresh failed — keeping the previous snapshot: {}", e.toString());
            warned = true;
        }
    }

    List<AirspaceRecord> load(long editionId) {
        List<AirspaceRecord> out = new ArrayList<>();
        WKBReader wkb = new WKBReader(dev.wakeline.geo.GeoJson.GF);
        for (Map<String, Object> r : db.sql("""
                        SELECT id, category, type_ko, folder, type_code, ident, name, class_code, remarks, kind,
                               lower_ft, lower_basis, lower_raw, upper_ft, upper_basis, upper_raw,
                               CASE WHEN kind = 'polygon' THEN ST_AsBinary(geom) END AS wkb, ST_AsGeoJSON(geom_display, 5) AS display
                        FROM airspace WHERE edition_id = :e ORDER BY id""")
                .param("e", editionId).query().listOfRows()) {
            Geometry g = null;
            if (r.get("wkb") instanceof byte[] b) {
                try {
                    g = wkb.read(b);
                } catch (ParseException e) {
                    throw new IllegalStateException("airspace " + r.get("id") + ": bad WKB", e);
                }
            }
            out.add(new AirspaceRecord(((Number) r.get("id")).longValue(), (String) r.get("category"), (String) r.get("type_ko"), (String) r.get("folder"),
                    (String) r.get("type_code"), (String) r.get("ident"), (String) r.get("name"), (String) r.get("class_code"), (String) r.get("remarks"),
                    (String) r.get("kind"), limit(r, "lower"), limit(r, "upper"), g, json.readTree((String) r.get("display"))));
        }
        return List.copyOf(out);
    }

    private static AirspaceRecord.Limit limit(Map<String, Object> r, String side) {
        Object ft = r.get(side + "_ft");
        return new AirspaceRecord.Limit(ft == null ? null : ((Number) ft).intValue(), (String) r.get(side + "_basis"), (String) r.get(side + "_raw"));
    }
}
