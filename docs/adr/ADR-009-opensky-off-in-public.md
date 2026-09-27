# ADR-009 OpenSky 는 로컬·연구 범위에서만, 공개 배포 시 기본 OFF

OpenSky 약관은 운영 목적 REST 사용에 서면 동의를 요구한다. 자격증명이 없으면 전세계 뷰는 조용히 비활성이며(로그 1회), 관심 지역(adsb.lol → adsb.fi 폴백)만 동작한다. 자격증명은 collector 컨테이너에만 주입된다.
