package dev.wakeline.domain;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 알림. 근거(evidence) 없이는 생성되지 않는다. kind = OBSERVED | PREDICTED.
 * closeReason: 닫힌 이유(left | signal_lost | restart | prediction_cleared), 열려 있으면 null.
 * etaAt: PREDICTED 전용 — 판정 시각(evidence.judged_at) + etaS. 클라이언트는 이 절대 시각에서 남은 시간을 센다.
 */
public record Alert(
        long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
        Instant enteredAt, Instant leftAt, String closeReason, Integer etaS, Instant etaAt, Integer altFt,
        Map<String, Object> evidence, boolean estimated) {

    public static final String CLOSE_LEFT = "left";
    public static final String CLOSE_SIGNAL_LOST = "signal_lost";
    public static final String CLOSE_RESTART = "restart";
    public static final String CLOSE_PREDICTION_CLEARED = "prediction_cleared";

    /** 이전 시그니처 호환(closeReason·etaAt 없음). 새 코드는 전체 생성자를 쓴다. */
    public Alert(long id, String kind, String hex, String callsign, String sigmetId, String firId, String hazard, String qualifier,
                 Instant enteredAt, Instant leftAt, Integer etaS, Integer altFt, Map<String, Object> evidence, boolean estimated) {
        this(id, kind, hex, callsign, sigmetId, firId, hazard, qualifier, enteredAt, leftAt, null, etaS, null, altFt, evidence, estimated);
    }

    public boolean active() { return leftAt == null; }

    /** 닫힌 사본. extraEvidence 가 있으면 근거 사본에 덧붙인다(원본 근거는 바꾸지 않는다). */
    public Alert closed(Instant at, String reason, Map<String, Object> extraEvidence) {
        Map<String, Object> ev = evidence;
        if (extraEvidence != null && !extraEvidence.isEmpty()) {
            ev = new LinkedHashMap<>(evidence);
            ev.putAll(extraEvidence);
        }
        return new Alert(id, kind, hex, callsign, sigmetId, firId, hazard, qualifier, enteredAt, at, reason, etaS, etaAt, altFt, ev, estimated);
    }
}
