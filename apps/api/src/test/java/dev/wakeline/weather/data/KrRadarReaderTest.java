package dev.wakeline.weather.data;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 기상청 레이더 읽기(KrRadarReader — WeatherController 에서 옮긴 Redis 읽기)의 Redis 오류 뜻은 읽는 것마다 예전과 같다: 목록 · 메타는 '모름'(빈 해시 · 목록 없음 —
 * /radar/kr 는 사용 불가로 답한다), 프레임 존재 확인은 '없음'(빈 목록), 프레임 PNG 는 던진다(ProblemAdvice 가 503 — 리뷰 cto-2026-10 A3 결정 6).
 */
class KrRadarReaderTest {
    /** 연결 팩토리가 없어 모든 명령이 실패하는 템플릿 대신, 명령마다 Redis 연결 실패를 던지는 템플릿. */
    static StringRedisTemplate down() {
        return new StringRedisTemplate() {
            @Override public <T> T execute(org.springframework.data.redis.core.RedisCallback<T> action, boolean exposeConnection, boolean pipeline) {
                throw new RedisConnectionFailureException("redis down");
            }
        };
    }

    @Test
    void aRedisOutageReadsAsUnknownForTheListingAndAsMissingForFrameKeys() {
        KrRadarReader r = new KrRadarReader(down());
        KrRadarReader.Listing l = r.listing();
        assertThat(l.meta()).isEqualTo(Map.of());
        assertThat(l.framesJson()).isNull();
        assertThat(r.framesExist(List.of("202609291440"))).isEmpty();
    }

    @Test
    void noFramesToCheckAsksRedisNothing() {
        assertThat(new KrRadarReader(null).framesExist(List.of())).isEmpty();
    }

    @Test
    void aRedisOutageOnTheFrameImageIsThrownNotReadAsMissing() {
        assertThatThrownBy(() -> new KrRadarReader(down()).frame("202609291440")).isInstanceOf(RedisConnectionFailureException.class);
    }
}
