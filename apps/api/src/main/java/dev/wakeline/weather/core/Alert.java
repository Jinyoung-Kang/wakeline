package dev.wakeline.weather.core;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 알림. 근거(evidence) 없이는 생성되지 않는다. kind = OBSERVED | PREDICTED.
 * closeReason: 닫힌 이유(left | signal_lost | restart | sigmet_ended | prediction_cleared), 열려 있으면 null.
 * sigmet_ended = 항공기가 나간 것이 아니라 경보(SIGMET)가 만료·철회(취소·대체)되어 끝났다(DH-6·API-CONC-4).
 * etaAt: PREDICTED 전용 — 판정 시각(evidence.judged_at) + etaS. 클라이언트는 이 절대 시각에서 남은 시간을 센다.
 * <p>구역(ADR-035): SIGMET 알림은 sigmetId · firId · hazard · qualifier 가 있고 zoneType · level · airspace 는 null 이다(직렬화에서 빠진다 — 계약 그대로).
 * 다른 구역(공역)의 알림은 zoneType 이 그 종류이고 SIGMET 필드는 null 이다.
 */
public record Alert(
        long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
        Instant enteredAt, Instant leftAt, String closeReason, Integer etaS, Instant etaAt, Integer altFt,
        Map<String, Object> evidence, boolean estimated,
        String zoneType, String level, Map<String, Object> airspace) {

    public static final String CLOSE_LEFT = "left";
    public static final String CLOSE_SIGNAL_LOST = "signal_lost";
    public static final String CLOSE_RESTART = "restart";
    public static final String CLOSE_PREDICTION_CLEARED = "prediction_cleared";
    public static final String CLOSE_SIGMET_ENDED = "sigmet_ended";

    /** 구역이 정하는 알림 머리(Zone#head). SIGMET 은 앞 네 필드, 공역은 뒤 세 필드. */
    public record Head(String sigmetId, String firId, String hazard, String qualifier, String zoneType, String level, Map<String, Object> airspace) {}

    /** SIGMET 알림(구역 필드 없음). 새 코드는 {@link #of} 를 쓴다. */
    public Alert(long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
                 Instant enteredAt, Instant leftAt, String closeReason, Integer etaS, Instant etaAt, Integer altFt,
                 Map<String, Object> evidence, boolean estimated) {
        this(id, kind, hex, callsign, sigmetId, firId, hazard, qualifier, enteredAt, leftAt, closeReason, etaS, etaAt, altFt, evidence, estimated,
                null, null, null);
    }

    /** 이전 시그니처 호환(closeReason·etaAt 없음). 새 코드는 전체 생성자를 쓴다. */
    public Alert(long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
                 Instant enteredAt, Instant leftAt, Integer etaS, Integer altFt, Map<String, Object> evidence, boolean estimated) {
        this(id, kind, hex, callsign, sigmetId, firId, hazard, qualifier, enteredAt, leftAt, null, etaS, null, altFt, evidence, estimated);
    }

    /** 구역의 머리로 만든 열린 알림. */
    public static Alert of(long id, String kind, String hex, String callsign, Head h, Instant enteredAt, Integer etaS, Instant etaAt, Integer altFt,
                           Map<String, Object> evidence, boolean estimated) {
        return new Alert(id, kind, hex, callsign, h.sigmetId(), h.firId(), h.hazard(), h.qualifier(), enteredAt, null, null, etaS, etaAt, altFt,
                evidence, estimated, h.zoneType(), h.level(), h.airspace());
    }

    public boolean active() { return leftAt == null; }

    /** 구역 종류 — 필드가 없으면 SIGMET(계약: 없으면 sigmet). */
    public String zoneTypeOrSigmet() { return zoneType == null ? Zone.SIGMET : zoneType; }

    /** 닫힌 사본. extraEvidence 가 있으면 근거 사본에 덧붙인다(원본 근거는 바꾸지 않는다). */
    public Alert closed(Instant at, String reason, Map<String, Object> extraEvidence) {
        Map<String, Object> ev = evidence;
        if (extraEvidence != null && !extraEvidence.isEmpty()) {
            ev = new LinkedHashMap<>(evidence);
            ev.putAll(extraEvidence);
        }
        return new Alert(id, kind, hex, callsign, sigmetId, firId, hazard, qualifier, enteredAt, at, reason, etaS, etaAt, altFt, ev, estimated,
                zoneType, level, airspace);
    }
}
