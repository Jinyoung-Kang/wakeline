package dev.wakeline.airspace.core;

import java.time.Instant;

/** 가져온 차수 하나(V18 airspace_edition). label 은 운영자가 준 기준 차수 이름(예: 'AIP 25년 5차'). */
public record AirspaceEdition(long id, String label, String documentName, String sha256, Instant importedAt) {
    /** ETag · 판(version)에 쓰는 짧은 열쇠 — 차수 id 와 원본 SHA 앞 12자. */
    public String tag() { return id + "-" + sha256.substring(0, Math.min(12, sha256.length())); }
}
