package dev.wakeline.demand;

import java.util.List;
import java.util.Map;

/**
 * 수요 임대 저장소(ADR-013, 계약 v2 §A1). api 가 유일한 작성자이고 수집기는 읽기만 한다(Redis ACL %R~).
 * <ul>
 *   <li>ZSET {@value #HOT} member = 셀 키, score = 만료 epoch ms · HASH {@value #HOT_META} 셀 키 → {lat, lon, radius_nm, sessions, first_at}</li>
 *   <li>ZSET {@value #FOCUS} member = hex, score = 만료 epoch ms · HASH {@value #FOCUS_META} hex → {sessions, first_at, callsign?}
 *       (callsign = api 가 보이는 콜사인을 정규화한 값, 노선 조회용 — 계약 v4 §G A-1. 모르면 키 없음)</li>
 *   <li>HASH {@value #STATUS}(수집기가 쓴다) focus:{hex} / hot:{셀 키} → {state, interval_s, last_success_at, last_error, provider}</li>
 * </ul>
 */
public interface DemandLeases {
    String HOT = "wakeline:demand:hot";
    String HOT_META = "wakeline:demand:hot:meta";
    String FOCUS = "wakeline:demand:focus";
    String FOCUS_META = "wakeline:demand:focus:meta";
    String STATUS = "wakeline:demand:status";

    /** 임대 하나: ZSET member 와 meta JSON. */
    record Lease(String member, String metaJson) {}

    /**
     * 임대 전체를 원자적으로 바꾼다 — 이번 계산에 없는 임대(만료·수요 없음·상한 밖)는 사라지고, 있는 것은 expiresAtMs 로 갱신된다.
     * 수집기는 바꾸기 전 또는 후만 본다(중간 상태 없음). 실패하면 예외(수집기는 이전 임대를 각자의 만료까지 쓴다).
     */
    void replace(List<Lease> hot, List<Lease> focus, long expiresAtMs);

    /** 수요 상태 필드 원문(JSON). 없는 필드는 결과에 없다. 실패하면 예외. */
    Map<String, String> status(List<String> fields);
}
