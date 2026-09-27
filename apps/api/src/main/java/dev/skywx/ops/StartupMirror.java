package dev.skywx.ops;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** 기동 시 DB 설정을 Redis 로 미러해 collector 가 항상 같은 값을 본다. */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class StartupMirror {
    private static final Logger log = LoggerFactory.getLogger(StartupMirror.class);
    private final SettingsService settings;

    public StartupMirror(SettingsService settings) { this.settings = settings; }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        try { settings.mirror(); log.info("settings mirrored to redis"); } catch (RuntimeException e) { log.warn("settings mirror failed: {}", e.toString()); }
    }
}
