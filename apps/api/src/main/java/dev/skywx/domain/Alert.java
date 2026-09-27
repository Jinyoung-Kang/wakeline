package dev.skywx.domain;

import java.time.Instant;
import java.util.Map;

/** 알림. 근거(evidence) 없이는 생성되지 않는다. kind = OBSERVED | PREDICTED. */
public record Alert(
        long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
        Instant enteredAt, Instant leftAt, Integer etaS, Integer altFt, Map<String, Object> evidence, boolean estimated) {

    public boolean active() { return leftAt == null; }
}
