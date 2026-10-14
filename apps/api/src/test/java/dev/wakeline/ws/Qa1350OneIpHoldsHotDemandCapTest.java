package dev.wakeline.ws;

import dev.wakeline.demand.DemandLeases;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1350(QA 2026-10-aws · 공개 데모 A1): 핫 리전 수요 임대의 전역 상한은 6 셀(DemandService.MAX_HOT_CELLS)인데 IP 당 WS 연결 상한은 5
 * (WAKELINE_WS_MAX_CONN_PER_IP)이고, 상한 안의 순위는 "세션 수 많은 순 → 먼저 요청된 순"(DemandService.choose)뿐이다 — IP · 방문자 몫이 없다.
 * 그래서 한 IP(한 브라우저 컨텍스트 — 탭 5개나 스크립트)가 먼저 연결해 관심 지역 밖 서로 다른 다섯 곳을 줌 ≥ 7 로 보고 있으면, 연결을 유지하는 동안
 * 셀 6개 중 5개를 차지하고(핫 리전에는 30분 같은 시간 상한도 없다), 뒤에 온 다른 방문자의 두 번째 셀은 throttled 가 된다.
 * 공개 데모(OpenSky 끔)에서는 관심 지역 밖 항공기를 보는 길이 핫 리전뿐이라 그 방문자는 그 곳의 항공기를 받지 못한다.
 * 실제 스택(A1)에서도 같은 결과: tools/qa/pd_ws_demand_hog.py — docs/qa/2026-10-aws/evidence/public-demo/ws-demand-hog.json.
 * <p>기대(QA 계획 §2-1 '잠금 통과자의 남용 — 전역 상한을 혼자 차지하는가', ADR-039 덧붙임 2-5 가 IP 별 제한으로 막으려던 것): 한 IP 가 전역 상한을
 * 사실상 혼자 차지하지 못한다 — 뒤에 온 다른 IP 의 방문자가 새로 본 두 곳이 모두 임대된다(이 시험은 그 결과만 본다 — 방법은 IP 당 몫 · 순위 등 고칠 때 정한다).
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.ws.Qa1350OneIpHoldsHotDemandCapTest'}
 */
class Qa1350OneIpHoldsHotDemandCapTest {
    static String sub(double lon, double lat) {
        return "{\"type\":\"subscribe\",\"bbox\":[%.1f,%.1f,%.1f,%.1f],\"zoom\":8}".formatted(lon - 0.6, lat - 0.5, lon + 0.6, lat + 0.5);
    }

    @Test
    void oneIpWithFiveConnectionsDoesNotCrowdOutTheNextVisitor() throws Exception {
        try (DemandServiceTest.Rig r = new DemandServiceTest.Rig()) {
            // 한 IP: 관심 지역(36.5, 127.8 · 250 NM) 밖 다섯 곳 — 도쿄 · 상하이 · 베이징 · 타이베이 · 오사카
            double[][] hog = {{139.7, 35.7}, {121.5, 31.2}, {116.4, 39.9}, {121.5, 25.0}, {135.5, 34.7}};
            List<FakeWsSession> hogs = new ArrayList<>();
            for (int i = 0; i < hog.length; i++) {
                FakeWsSession f = r.k.connect("hog" + i, "203.0.113.7");
                r.k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
                r.k.msg(f, sub(hog[i][0], hog[i][1]));
                hogs.add(f);
            }
            FakeWsSession sixth = r.k.connect("hog5", "203.0.113.7");
            assertThat(sixth.isOpen()).as("IP 당 연결 상한 5 — 6번째는 닫힌다(대조)").isFalse();
            r.refresh();
            r.clock.addAndGet(5_000);

            // 다른 IP 의 방문자 — 두 탭으로 마닐라 · 홍콩
            FakeWsSession v1 = r.k.connect("v1", "198.51.100.20");
            r.k.msg(v1, "{\"type\":\"hello\",\"proto\":1}");
            r.k.msg(v1, sub(121.0, 14.6));
            FakeWsSession v2 = r.k.connect("v2", "198.51.100.20");
            r.k.msg(v2, "{\"type\":\"hello\",\"proto\":1}");
            r.k.msg(v2, sub(114.2, 22.3));
            r.refresh();

            List<String> hot = r.leases.last().hot().stream().map(DemandLeases.Lease::member).toList();
            String s1 = DemandServiceTest.lastDemand(v1).path("hot").path("state").asString();
            String s2 = DemandServiceTest.lastDemand(v2).path("hot").path("state").asString();
            long byHog = hogs.stream().filter(f -> !"throttled".equals(DemandServiceTest.lastDemand(f).path("hot").path("state").asString())).count();
            System.out.printf("QA-1350 leased=%s hogIpLeased=%d/%d visitor=[%s, %s]%n", hot, byHog, DemandService.MAX_HOT_CELLS, s1, s2);
            assertThat(List.of(s1, s2))
                    .as("다른 방문자의 두 곳 — 한 IP(203.0.113.7)가 핫 리전 %d 셀 중 %d 개를 쥐고 있다: %s", DemandService.MAX_HOT_CELLS, byHog, hot)
                    .doesNotContain("throttled");
        }
    }
}
