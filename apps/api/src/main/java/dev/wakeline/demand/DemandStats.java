package dev.wakeline.demand;

import org.springframework.stereotype.Component;

/**
 * 마지막 수요 계산의 수(개수만 — hex·셀은 내보내지 않는다). /api/v1/status 의 demand 와 지표가 읽는다.
 * hotActive·focusActive: 임대 중이고 수집기가 최근에 성공했다고 보고한 셀·hex 수. *Leased: 임대 수(상한 적용 뒤). *Wanted: 상한 전 수요.
 */
@Component
public class DemandStats {
    public record Counts(int hotActive, int focusActive, int hotLeased, int focusLeased, int hotWanted, int focusWanted) {
        public static final Counts NONE = new Counts(0, 0, 0, 0, 0, 0);
    }

    private volatile Counts counts = Counts.NONE;

    public Counts counts() { return counts; }

    public void update(Counts c) { counts = c == null ? Counts.NONE : c; }
}
