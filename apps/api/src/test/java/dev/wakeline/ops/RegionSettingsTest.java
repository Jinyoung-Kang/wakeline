package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.Problem;
import dev.wakeline.domain.Bbox;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.HashOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/** 관심 지역 해석은 collector(runtime_settings.region)와 같은 규칙, 설정 검증은 숫자 범위(COR-12). */
class RegionSettingsTest {
    static final RegionSettings.Region DEF = new RegionSettings.Region(36.5, 127.8, 250);

    @Test
    void parsesLikeTheCollector() {
        assertThat(RegionSettings.parse("35.5,139.7", "300", DEF)).isEqualTo(new RegionSettings.Region(35.5, 139.7, 300));
        assertThat(RegionSettings.parse(" 35.5 , 139.7 ", "300", DEF)).isEqualTo(new RegionSettings.Region(35.5, 139.7, 300));
        assertThat(RegionSettings.parse(null, null, DEF)).isEqualTo(DEF);                  // 해시에 값 없음 → 기본값
        assertThat(RegionSettings.parse("nonsense", "abc", DEF)).isEqualTo(DEF);           // 해석 실패 → 기본값
        assertThat(RegionSettings.parse("1,2,3", "250", DEF)).isEqualTo(DEF);
        assertThat(RegionSettings.parse("36,127", "10", DEF).radiusNm()).isEqualTo(50);    // [50, 500] 로 자른다
        assertThat(RegionSettings.parse("36,127", "9999", DEF).radiusNm()).isEqualTo(500);
    }

    @Test
    void bboxCoversTheRegionCircle() {
        Bbox b = new RegionSettings.Region(36.0, 127.0, 60).bbox();
        assertThat(b.lamin()).isCloseTo(35.0, within(1e-9));
        assertThat(b.lamax()).isCloseTo(37.0, within(1e-9));
        assertThat(b.lomax() - 127.0).isCloseTo(1.0 / Math.cos(Math.toRadians(36)), within(1e-9));
        Bbox edge = new RegionSettings.Region(0, 179.5, 120).bbox();
        assertThat(edge.lomax()).isEqualTo(180.0);
    }

    @Test
    void regionCenterIsValidatedNumerically() {
        assertThatCode(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode("36.5,127.8"))).doesNotThrowAnyException();
        assertThatCode(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode("-85,-180"))).doesNotThrowAnyException();
        for (String bad : new String[]{"99,127", "36.5,999", "85.1,0", "36.5,180.5", "36.5", "a,b", "36.5;127.8"})
            assertThatThrownBy(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode(bad))).as(bad).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.numberNode(36))).isInstanceOf(Problem.class);
    }

    @Test
    void aisBboxesFollowTheCollectorRules() {
        for (String ok : new String[]{"", "  ", "18,105,46,150", "-90,-180,90,180", "18,105,46,150; 30,-10,60,40;", " 1.5 , 2.25 ,3,4 "})
            assertThatCode(() -> SettingsService.validate("ais_bboxes", JsonNodeFactory.instance.stringNode(ok))).as(ok).doesNotThrowAnyException();
        String seventeen = String.join(";", java.util.Collections.nCopies(17, "0,0,1,1"));
        for (String bad : new String[]{"18,105,46", "18,105,46,150,1", "91,0,1,1", "0,181,1,1", "10,0,10,5", "0,5,1,5", "a,b,c,d",
                "1e1,0,1,1", "NaN,0,1,1", "Infinity,0,1,1", "0x10,0,1,1", "1d,0,1,1", ";", seventeen, "1".repeat(1025)})
            assertThatThrownBy(() -> SettingsService.validate("ais_bboxes", JsonNodeFactory.instance.stringNode(bad))).as(bad).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> SettingsService.validate("ais_bboxes", JsonNodeFactory.instance.numberNode(1))).isInstanceOf(Problem.class);
    }

    /** 계약 v4 §D: '|' 로 구역을 나눈다(최대 3 — 구역마다 연결 하나). 구역마다 상자 1~16, 전체 1,024자 — ais/bbox.py 와 같은 규칙. */
    @Test
    void aisBboxesAcceptTheShardGrammar() {
        String sixteen = String.join(";", java.util.Collections.nCopies(16, "0,0,1,1"));
        for (String ok : new String[]{"-90,-180,90,0|-90,45,90,180", "-90,-180,90,0;-90,45,90,180", "0,0,1,1|2,2,3,3|4,4,5,5",
                sixteen + "|" + sixteen + "|" + sixteen, " 0,0,1,1 ; | 2,2,3,3 "})
            assertThatCode(() -> SettingsService.validate("ais_bboxes", JsonNodeFactory.instance.stringNode(ok))).as(ok).doesNotThrowAnyException();
        String seventeen = String.join(";", java.util.Collections.nCopies(17, "0,0,1,1"));
        String tenLong = String.join(";", java.util.Collections.nCopies(10, "0.123456,0.123456,1.123456,1.123456"));
        for (String bad : new String[]{"0,0,1,1|2,2,3,3|4,4,5,5|6,6,7,7", "0,0,1,1|", "|0,0,1,1", "0,0,1,1||2,2,3,3", "0,0,1,1|" + seventeen,
                "0,0,1,1|91,0,1,1", "|", tenLong + "|" + tenLong + "|" + tenLong}) {
            assertThatThrownBy(() -> SettingsService.validate("ais_bboxes", JsonNodeFactory.instance.stringNode(bad))).as(bad)
                    .isInstanceOf(Problem.class).hasMessageNotContaining("0,0,1,1"); // 입력값을 되풀이하지 않는다
        }
    }

    /**
     * API-CONC-7: TTL 만료로 시작된 백그라운드 갱신이 옛 값을 읽고 있는 동안 설정이 바뀌어 요청 스레드가 refreshNow 를 불러도,
     * 마지막으로 반영되는 값은 새 값이어야 한다(이전에는 늦게 끝난 백그라운드 갱신이 옛 값으로 덮어썼다).
     */
    @Test
    @SuppressWarnings("unchecked")
    void concurrentRefreshCannotOverwriteANewerValueWithAnOlderRead() throws Exception {
        HashOperations<String, Object, Object> hash = mock(HashOperations.class);
        CountDownLatch backgroundReading = new CountDownLatch(1);
        CountDownLatch releaseBackground = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        when(hash.multiGet(any(), anyCollection())).thenAnswer(inv -> {
            if (calls.incrementAndGet() == 1) { // 백그라운드 갱신: 미러 전에 옛 값을 읽고 늦게 돌아온다
                backgroundReading.countDown();
                releaseBackground.await(5, TimeUnit.SECONDS);
                return List.of("36.5,127.8", "250");
            }
            return List.of("35.5,139.7", "150"); // 미러 뒤의 새 값
        });
        StringRedisTemplate redis = new StringRedisTemplate() {
            @Override public <HK, HV> HashOperations<String, HK, HV> opsForHash() { return (HashOperations<String, HK, HV>) (HashOperations<?, ?, ?>) hash; }
        };
        AppProperties props = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30, 120, List.of(), List.of());
        RegionSettings region = new RegionSettings(redis, null, null, props);

        Thread background = Thread.ofVirtual().start(region::refreshNow);
        assertThat(backgroundReading.await(5, TimeUnit.SECONDS)).isTrue();
        Thread update = Thread.ofVirtual().start(region::refreshNow); // SettingsService.update: 미러 → refreshNow
        Thread.sleep(100);
        releaseBackground.countDown();
        background.join(5_000);
        update.join(5_000);
        assertThat(region.current()).isEqualTo(new RegionSettings.Region(35.5, 139.7, 150));
    }

    /**
     * 리뷰 cto-2026-10 A2(B5-b): 정수 설정의 검사(intRange)가 int 밖의 정수에 asInt() 를 불러 던졌다 — 운영자의 PUT 이 400 BAD_VALUE 대신 500 이었다.
     * 정수가 아니거나 int 밖이거나 범위 밖이면 모두 400(Problem).
     */
    @Test
    void integerSettingsRejectOutOfRangeAndNonIntegerValuesAsBadValue() {
        var f = JsonNodeFactory.instance;
        assertThatCode(() -> SettingsService.validate("region_poll_s", f.numberNode(15))).doesNotThrowAnyException();
        assertThatCode(() -> SettingsService.validate("region_poll_s", f.numberNode(15L))).doesNotThrowAnyException();
        for (var bad : List.of(f.numberNode(4_294_967_306L), f.numberNode(-4_294_967_306L), f.numberNode(new java.math.BigInteger("123456789012345678901234567890")),
                f.numberNode(4), f.numberNode(121), f.numberNode(15.0), f.numberNode(1e10), f.stringNode("15"), f.booleanNode(true), f.nullNode()))
            assertThatThrownBy(() -> SettingsService.validate("region_poll_s", bad)).as(bad.toString()).isInstanceOf(Problem.class)
                    .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("BAD_VALUE"));
    }
}
