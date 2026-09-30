package dev.wakeline.rest;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30 — 목록은 RDR_CMP_HSR_EXT_* 를 계속 싣는데 내려받기가 08:15 KST 부터
 * "# file not exist (RDR_CMP_HSR_PUB_&lt;tm&gt;.bin.gz)" 로 답했다): 수집기 해시 wakeline:radar_kr:meta 의 missing_* → 공개 missing
 * (/radar/kr · /status 의 radar_kr 가 같은 규칙으로 싣는다).
 * <ul>
 *   <li>since_tm · last_tm: 없다는 답을 받은 가장 이른 · 가장 새 tm(YYYYMMDDHHMM, 기상청 KST 벽시계 그대로 — last_tm ≥ since_tm)</li>
 *   <li>tms: 없다는 답을 받은 서로 다른 tm 수(1 이상) · checked_at: 수집기가 마지막으로 확인한 순간(시간대 있는 시각)</li>
 *   <li>file: 기상청 답이 없다고 적은 파일 이름(RDR_CMP_…_&lt;tm&gt;.bin.gz — 답 그대로) · listed: 목록이 그 tm 에 싣는 파일 종류(["EXT"] — 목록 그대로)</li>
 *   <li>probe_every_s: 수집기의 지금 확인 간격(초 — 5분마다면 주기 300, 연속이 60분을 넘으면 늦춘 900, 둘 다 수집기 선택값. 계약 v5 §G26 · 2026-09-30 저녁)</li>
 * </ul>
 * 수집기 값을 믿지 않는다(R-72): since_tm 이 비었거나 없으면 연속이 없다(키 없음 — 세지 않는다). 핵심 값(since_tm · last_tm · tms · checked_at)이
 * 하나라도 틀리면 연속 전체를 모름(null)으로 두고 "missing" 으로 센다 — 일부만 보여 까닭을 틀리게 말하지 않는다. file · listed · probe_every_s 가 틀리면 그 키만 뺀다
 * (비었으면 — 옛 수집기 — 키가 없고 세지 않는다).
 */
final class KrRadarMissing {
    private static final Pattern TM = Pattern.compile("^\\d{12}$");
    private static final Pattern FILE = Pattern.compile("^RDR_CMP_[A-Z]+_[A-Z]+_\\d{12}\\.bin\\.gz$");
    private static final Pattern KIND = Pattern.compile("^[A-Z]{1,8}$");
    /** 목록 종류 수 상한(파일 이름의 한 마디 — 여러 개여도 몇 개다) */
    private static final int MAX_KINDS = 8;
    /** 확인 간격의 상한(초) — 하루. 그보다 긴 간격은 수집기가 고르지 않는다(틀린 값) */
    static final int MAX_PROBE_EVERY_S = 86_400;

    private KrRadarMissing() { }

    /** 수집기 해시 → 공개 missing. 연속이 없거나 핵심 값이 틀리면 null. */
    static Map<String, Object> from(Map<?, ?> h, Consumer<String> parseError) {
        String since = text(h.get("missing_since_tm"));
        if (since.isEmpty()) return null;
        String last = text(h.get("missing_last_tm"));
        Integer tms = positive(text(h.get("missing_tms")));
        Instant checked = StatusService.isoInstant(blankToNull(text(h.get("missing_checked_at"))));
        if (!TM.matcher(since).matches() || !TM.matcher(last).matches() || last.compareTo(since) < 0 || tms == null || checked == null) {
            parseError.accept("missing");
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("since_tm", since);
        m.put("last_tm", last);
        m.put("tms", tms);
        m.put("checked_at", checked);
        String file = text(h.get("missing_file"));
        if (FILE.matcher(file).matches()) m.put("file", file);
        else if (!file.isEmpty()) parseError.accept("missing_file");
        String listed = text(h.get("missing_listed"));
        if (!listed.isEmpty()) {
            List<String> kinds = kinds(listed);
            if (kinds != null) m.put("listed", kinds);
            else parseError.accept("missing_listed");
        }
        String every = text(h.get("missing_probe_every_s"));
        if (!every.isEmpty()) {
            Integer s = positive(every);
            if (s != null && s <= MAX_PROBE_EVERY_S) m.put("probe_every_s", s);
            else parseError.accept("missing_probe_every_s");
        }
        return m;
    }

    private static List<String> kinds(String listed) {
        String[] parts = listed.split(",", -1);
        if (parts.length > MAX_KINDS) return null;
        List<String> out = new ArrayList<>(parts.length);
        for (String p : parts) {
            if (!KIND.matcher(p).matches()) return null;
            out.add(p);
        }
        return out;
    }

    private static Integer positive(String s) {
        if (!s.matches("^[0-9]{1,6}$")) return null;
        int n = Integer.parseInt(s);
        return n >= 1 ? n : null;
    }

    private static String text(Object v) { return v == null ? "" : String.valueOf(v).trim(); }

    private static String blankToNull(String s) { return s.isEmpty() ? null : s; }
}
