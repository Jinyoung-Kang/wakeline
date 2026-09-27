# ADR-015 서비스 이름 변경: SkyWx → Wakeline

**상태** 채택 · 2026-09-28

항공기(항적)와 선박(항적·wake)을 함께 다루게 되어 이름을 Wakeline 으로 바꿨다. 코드·설정·Redis 키·DB·쿠키·이미지·compose 프로젝트를 모두 바꾸고, 원본 설계서 파일명(`docs/SkyWx_설계서_로컬개발용_v0.2.pdf`)과 `docs/audit` 감사 기록은 이력으로 남긴다.
오류 유형·스키마 식별자에 쓰던 `skywx.dev` 는 소유하지 않은 도메인이었다 → 등록될 수 없는 RFC 2606 예약 도메인 `wakeline.invalid` 로 바꿨다.
개발 데이터는 `tools/migrate-from-skywx.sh` 로 옮겼다: 볼륨 복사(compose 라벨) → `ALTER DATABASE/ROLE ... RENAME`(SCRAM 비밀번호 유지) → Redis 키 이름 변경(세션 폐기) → Flyway `repair`(마이그레이션 파일의 역할 이름이 바뀌어 체크섬만 재정렬). 이전 전후 행 수가 같음을 확인했다. 원본 `skywx_*` 볼륨은 사용자가 확인 후 지우도록 남겼다.
