package dev.wakeline.airspace.web;

import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Problem;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * 공역 레이어(계약 v5 §G47 · ADR-034 · SPEC F1). 켜진 차수 하나의 표시용 도형(단순화)과 속성 — 메모리 스냅숏에서만 답한다.
 * 자료가 없으면 200 + 빈 목록 + edition null(화면이 '공역 자료 없음 — 운영자가 가져오기 필요'를 보인다).
 * 국토교통부 저작물: 출처 · 차수를 응답에 늘 싣는다(화면이 표시). 최신 여부(AIRAC)는 확인하지 않는다.
 */
@RestController
@RequestMapping("/api/v1")
public class AirspaceController {
    static final String SOURCE = "국토교통부 공역정보 지도자료(AIP 차수 기준)";
    static final String PROVIDER = "molit_airspace";
    private static final Pattern CATEGORY = Pattern.compile("^[a-z_]{1,32}$");
    private static final int MAX_CATEGORIES = 32;
    private final AirspaceStore store;
    /** 차수마다 한 번 만든 Feature 목록(스냅숏 열쇠 → 목록). 요청마다 다시 만들지 않는다. */
    private volatile Map.Entry<String, List<Map<String, Object>>> built = Map.entry("", List.of());

    public AirspaceController(AirspaceStore store) { this.store = store; }

    @GetMapping(value = "/airspace", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> airspace(@RequestParam(required = false) String category, HttpServletRequest req) {
        Set<String> cats = categories(category);
        AirspaceStore.Snapshot snap = store.snapshot();
        String etag = "\"as" + snap.tag() + (cats == null ? "" : "-" + String.join(".", cats)) + "\"";
        CacheControl cc = CacheControl.maxAge(300, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        List<Map<String, Object>> features = new ArrayList<>();
        for (Map<String, Object> f : features(snap)) {
            if (cats == null || cats.contains(((Map<?, ?>) f.get("properties")).get("category"))) features.add(f);
        }
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("edition", snap.edition() == null ? tools.jackson.databind.node.NullNode.getInstance() : edition(snap));
        fc.put("source", SOURCE);
        fc.put("features", features);
        Instant at = snap.edition() == null ? null : snap.edition().importedAt();
        fc.put("meta", Meta.of(req, snap.edition() == null ? null : PROVIDER, at, Integer.MAX_VALUE));
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(fc);
    }

    /** null = 거르지 않음. 형식이 틀리면 400. */
    static Set<String> categories(String raw) {
        if (raw == null || spaces(raw).isEmpty()) return null; // isBlank 는 탭 · 줄바꿈 · 0x1F 도 공백으로 본다(QA-500 후속)
        Set<String> out = new TreeSet<>();
        for (String c : raw.split(",", -1)) {
            String t = spaces(c);
            if (!CATEGORY.matcher(t).matches()) throw Problem.badRequest("BAD_CATEGORY", "category: comma-separated [a-z_]{1,32}");
            out.add(t);
        }
        if (out.size() > MAX_CATEGORIES) throw Problem.badRequest("BAD_CATEGORY", "category: at most " + MAX_CATEGORIES);
        return out;
    }

    /** 앞뒤의 ASCII 공백(U+0020)만 지운다 — trim() 은 NUL · 탭 · 줄바꿈 · 0x1F 도 지워 틀린 값이 지났다(QA-500 · §G43 과 같은 부류). */
    static String spaces(String v) {
        int a = 0, b = v.length();
        while (a < b && v.charAt(a) == ' ') a++;
        while (b > a && v.charAt(b - 1) == ' ') b--;
        return v.substring(a, b);
    }

    private static Map<String, Object> edition(AirspaceStore.Snapshot snap) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", snap.edition().id());
        e.put("label", snap.edition().label());
        e.put("document_name", snap.edition().documentName());
        e.put("imported_at", snap.edition().importedAt());
        e.put("currency_checked", false);  // AIRAC 최신 여부는 확인하지 않는다(SPEC F1-4)
        return e;
    }

    private List<Map<String, Object>> features(AirspaceStore.Snapshot snap) {
        var b = built;
        if (b.getKey().equals(snap.tag())) return b.getValue();
        List<Map<String, Object>> out = new ArrayList<>(snap.records().size());
        for (AirspaceRecord r : snap.records()) out.add(feature(r));
        List<Map<String, Object>> list = List.copyOf(out);
        built = Map.entry(snap.tag(), list);
        return list;
    }

    static Map<String, Object> feature(AirspaceRecord r) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("id", r.id());
        p.put("category", r.category());
        p.put("type_ko", r.typeKo());
        p.put("ident", r.ident());
        p.put("name", r.name());
        p.put("label", r.label());
        p.put("class_code", r.classCode());
        p.put("kind", r.kind());
        p.put("lower", limit(r.lower()));
        p.put("upper", limit(r.upper()));
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("type", "Feature");
        f.put("id", String.valueOf(r.id()));
        f.put("geometry", r.display());
        f.put("properties", p);
        return f;
    }

    static Map<String, Object> limit(AirspaceRecord.Limit l) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ft", l.ft() == null ? tools.jackson.databind.node.NullNode.getInstance() : l.ft());
        m.put("basis", l.basis());
        m.put("raw", l.raw());
        return m;
    }
}
