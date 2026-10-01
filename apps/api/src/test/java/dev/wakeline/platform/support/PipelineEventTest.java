package dev.wakeline.platform.support;

import org.junit.jupiter.api.Test;
import org.springframework.context.event.EventListener;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 표시 범위(리뷰 cto-2026-10 api §2.5-1 · §5.4-2): 리스너 격리(PipelineEventMulticaster)는 페이로드의 {@link PipelineEvent} 표시로 정한다. 표시를 빠뜨린
 * 새 이벤트는 조용히 격리를 잃는다(리스너 하나의 예외가 스트림 소비로 새고 뒤 리스너가 건너뛰어진다) — 그래서 소스 전체를 본다.
 */
class PipelineEventTest {
    static final Path MAIN = Path.of("src/main/java");
    /** 이름은 *Events 지만 애플리케이션 이벤트 묶음이 아닌 것: 로그 줄의 모양(logs.LogEvents — Draft · Ex). */
    static final Set<String> NOT_EVENT_HOLDERS = Set.of("dev.wakeline.logs.LogEvents");

    /** src/main/java 의 최상위 클래스(초기화하지 않고 읽는다). */
    static List<Class<?>> mainClasses() throws IOException, ClassNotFoundException {
        assertThat(MAIN).as("run from apps/api (the gradle test working directory)").isDirectory();
        List<Class<?>> out = new ArrayList<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path p : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                String name = MAIN.relativize(p).toString().replace('\\', '/').replace('/', '.').replaceAll("\\.java$", "");
                out.add(Class.forName(name, false, PipelineEventTest.class.getClassLoader()));
            }
        }
        return out;
    }

    @Test
    void everyRecordInAnEventsHolderIsAPipelineEvent() throws Exception {
        Set<String> holders = new TreeSet<>();
        List<String> unmarked = new ArrayList<>();
        int records = 0;
        for (Class<?> c : mainClasses()) {
            if (!c.getSimpleName().endsWith("Events") || NOT_EVENT_HOLDERS.contains(c.getName())) continue;
            holders.add(c.getSimpleName());
            for (Class<?> r : c.getDeclaredClasses()) {
                if (!r.isRecord()) continue;
                records++;
                if (!PipelineEvent.class.isAssignableFrom(r)) unmarked.add(r.getName());
            }
        }
        assertThat(holders).as("event holders found").contains("AircraftEvents", "WeatherEvents", "ShipEvents", "EngineEvents");
        assertThat(records).isGreaterThanOrEqualTo(10);
        assertThat(unmarked).as("records in *Events classes without the PipelineEvent marker (their listeners would not be isolated)").isEmpty();
    }

    @Test
    void everyEventListenerForAnAppTypeTakesAPipelineEvent() throws Exception {
        List<String> unmarked = new ArrayList<>();
        int appListeners = 0;
        for (Class<?> c : mainClasses()) {
            for (Method m : c.getDeclaredMethods()) {
                EventListener l = m.getAnnotation(EventListener.class);
                if (l == null) continue;
                List<Class<?>> types = new ArrayList<>(List.of(m.getParameterTypes()));
                types.addAll(List.of(l.classes()));
                for (Class<?> t : types) {
                    if (!t.getName().startsWith("dev.wakeline.")) continue; // 프레임워크 이벤트(ApplicationReadyEvent 등)
                    appListeners++;
                    if (!PipelineEvent.class.isAssignableFrom(t)) unmarked.add(c.getSimpleName() + "#" + m.getName() + "(" + t.getName() + ")");
                }
            }
        }
        assertThat(appListeners).as("@EventListener methods on dev.wakeline payloads").isGreaterThanOrEqualTo(13);
        assertThat(unmarked).as("listeners of app events without the PipelineEvent marker").isEmpty();
    }
}
