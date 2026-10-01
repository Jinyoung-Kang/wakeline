package dev.wakeline.platform.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** 허용 Origin 목록 정리(SEC-7) — WS 핸드셰이크(OriginAllowList)가 쓰는 목록. */
public class AppPropertiesTest {
    @Test void originPatterns_dropWildcardAndBlanks_fallBackToDefaultWhenEmpty() {
        assertThat(AppProperties.normalizeOrigins(Arrays.asList(" http://a:1/ ", "*", "", null, "http://a:1"))).containsExactly("http://a:1");
        assertThat(AppProperties.normalizeOrigins(List.of("*"))).isEqualTo(AppProperties.DEFAULT_ALLOWED_ORIGINS);
        assertThat(AppProperties.normalizeOrigins(null)).isEqualTo(AppProperties.DEFAULT_ALLOWED_ORIGINS);
        assertThat(props(List.of("http://localhost:8701/", "http://127.0.0.1:8701")).originPatterns())
                .containsExactly("http://localhost:8701", "http://127.0.0.1:8701");
    }

    /**
     * `next dev`(http://localhost:3000 — /api 를 스택으로 넘긴다)의 opt-in: 환경변수 WAKELINE_EXTRA_ALLOWED_ORIGINS(compose 는 .env 의 EXTRA_ALLOWED_ORIGINS)가
     * application.yml 을 거쳐 같은 허용 목록(WS 핸드셰이크 · 운영 변경 요청의 출처 검사) 뒤에 붙는다. 비어 있는 기본값이면 목록은 그대로다.
     */
    @Test void extraAllowedOrigins_fromTheEnvironment_areAddedToTheSameList_emptyByDefault() throws IOException {
        List<String> stack = List.of("http://localhost:8700", "http://127.0.0.1:8700");
        assertThat(bind(Map.of()).originPatterns()).isEqualTo(stack);
        assertThat(bind(Map.of("WAKELINE_EXTRA_ALLOWED_ORIGINS", "")).originPatterns()).isEqualTo(stack);
        assertThat(bind(Map.of("WAKELINE_EXTRA_ALLOWED_ORIGINS", "http://localhost:3000")).originPatterns())
                .containsExactly("http://localhost:8700", "http://127.0.0.1:8700", "http://localhost:3000");
        // 같은 정리 규칙(공백 · 끝 '/' · 빈 값 · '*' · 중복) — 더할 뿐 기본 목록을 바꾸거나 열지 못한다
        assertThat(bind(Map.of("WAKELINE_EXTRA_ALLOWED_ORIGINS", " http://localhost:3000/ ,*,, http://localhost:8700,http://127.0.0.1:3000")).originPatterns())
                .containsExactly("http://localhost:8700", "http://127.0.0.1:8700", "http://localhost:3000", "http://127.0.0.1:3000");
        assertThat(bind(Map.of("WAKELINE_ALLOWED_ORIGINS", "http://localhost:8701", "WAKELINE_EXTRA_ALLOWED_ORIGINS", "http://localhost:3000")).originPatterns())
                .containsExactly("http://localhost:8701", "http://localhost:3000");
    }

    /** application.yml 그대로 + 주어진 환경변수만(실행하는 셸의 환경 · 시스템 속성은 섞지 않는다) → wakeline.* 바인딩. */
    static AppProperties bind(Map<String, Object> env) throws IOException {
        StandardEnvironment e = new StandardEnvironment();
        e.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        e.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        new YamlPropertySourceLoader().load("application.yml", new ClassPathResource("application.yml")).forEach(e.getPropertySources()::addLast);
        e.getPropertySources().addFirst(new MapPropertySource("env", env));
        return Binder.get(e).bind("wakeline", AppProperties.class).get();
    }

    public static AppProperties props(List<String> origins) {
        return props(origins, List.of());
    }

    public static AppProperties props(List<String> origins, List<String> extra) {
        return new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30, 120, origins, extra);
    }
}
