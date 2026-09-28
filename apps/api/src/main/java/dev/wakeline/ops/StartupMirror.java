package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 기동 시: .env 관심 지역을 런타임 설정에 맞추고(운영자가 바꾼 적 없는 값만, COR-12) DB 설정을 Redis 로 미러해 collector 가 항상 같은 값을 본다.
 * 그 뒤 60 s 마다 다시 미러한다 — 변경 직후 미러가 Redis 장애로 실패했거나 Redis 가 재시작돼 해시가 비었어도 스스로 맞춰진다.
 * 공급자 스위치도 같은 방식이다(R-94, 계약 v5 §D1): 원본은 DB provider_switch — 행이 없는 공급자는 그때의 Redis 값을 한 번 옮겨 담고(이관),
 * DB → Redis wakeline:provider:{name}.disabled 를 다시 미러한다. collector 가 그 값을 바꿔도 1분 안에 돌아온다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class StartupMirror {
    private static final Logger log = LoggerFactory.getLogger(StartupMirror.class);
    private final SettingsService settings;
    private final RegionSettings region;
    private final AuditService audit;
    private final AppProperties props;
    private final ProviderSwitchService switches;
    private volatile boolean seeded;

    public StartupMirror(SettingsService settings, RegionSettings region, AuditService audit, AppProperties props, ProviderSwitchService switches) {
        this.settings = settings;
        this.region = region;
        this.audit = audit;
        this.props = props;
        this.switches = switches;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        seedOnce();
        try { settings.mirror(); log.info("settings mirrored to redis"); } catch (RuntimeException e) { log.warn("settings mirror failed: {}", e.toString()); }
        syncSwitches(true);
        region.refreshNow();
    }

    @Scheduled(initialDelay = 60_000, fixedDelay = 60_000)
    public void periodicMirror() {
        seedOnce(); // 기동 때 DB 가 없었으면 여기서 다시 시도
        try { settings.mirror(); } catch (RuntimeException e) { log.debug("periodic settings mirror failed: {}", e.toString()); }
        syncSwitches(false);
        region.refreshNow();
    }

    /**
     * 공급자 스위치 이관 + DB → Redis 미러. Redis 값이 DB 와 달라 고쳐 쓴 공급자는 경고로 남긴다 — collector 가 바꿨거나 Redis 를 잃었다는 뜻이다
     * (토글 직후의 미러는 여기로 오지 않는다). 실패하면(Redis·DB 장애) 다음 주기에 다시 한다.
     */
    private void syncSwitches(boolean startup) {
        try {
            var r = switches.sync();
            if (!r.imported().isEmpty()) log.info("provider switches imported from redis into provider_switch: {}", r.imported());
            if (!r.corrected().isEmpty()) log.warn("provider switch in redis differed from provider_switch — restored from the database: {}", r.corrected());
        } catch (RuntimeException e) {
            if (startup) log.warn("provider switch sync failed (will retry every 60 s): {}", e.toString());
            else log.debug("periodic provider switch sync failed: {}", e.toString());
        }
    }

    private void seedOnce() {
        if (seeded) return;
        try {
            var changed = settings.seedFromEnv(props.regionCenter(), props.regionRadiusNm(), audit);
            if (!changed.isEmpty()) log.info("runtime settings aligned with .env: {}", changed);
            seeded = true;
        } catch (RuntimeException e) {
            log.warn("env → runtime settings alignment failed (will retry): {}", e.toString());
        }
    }
}
