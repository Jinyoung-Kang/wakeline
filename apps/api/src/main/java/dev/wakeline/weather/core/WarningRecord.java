package dev.wakeline.weather.core;

import java.time.Instant;

/**
 * 기상특보 하나(기상청 특보현황 — ADR-036 · 계약 v5 §G49). 값은 수집기가 원문에서 옮긴 것: 종류 · 수준 · 명령은 원문 글자 그대로(풍랑 · 주의보 · 발표 …),
 * 시각은 UTC. 예비특보는 정확한 발효 시각이 없다(effectiveAt null — 때 effectiveFrom · effectiveTo · effectiveText). 모르는 값은 null.
 */
public record WarningRecord(String zoneCode, String zoneName, String parentCode, String parentName, boolean sea, String kind, String level,
                            String command, boolean preliminary, Instant issuedAt, Instant effectiveAt, Instant effectiveFrom, Instant effectiveTo,
                            String effectiveText, String endNotice, String raw) {
    /** 자연키 — 같은 구역 · 종류 · 수준 · 발표 시각이면 같은 특보(V20 wx_warning_natural_key). */
    public String key() { return zoneCode + "|" + kind + "|" + level + "|" + issuedAt; }
}
