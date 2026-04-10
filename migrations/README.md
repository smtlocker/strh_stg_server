# 마이그레이션

새 중계서버 배치 시 실행이 필요한 DB 스키마 변경 및 데이터 마이그레이션.

## 한 번에 실행

```bash
npm run migrate
```

5단계를 순차 실행하며, 실패 시 중단됩니다. 로그는 `logs/migrate-*.log`에 자동 저장됩니다.

## 개별 실행

```bash
# SQL 실행 (001, 002)
node migrations/run-sql.js migrations/001-init-schema.sql

# JS 마이그레이션 (003~005) — 기본 DRY_RUN=true
node migrations/003-upsert-unit-smartcube-ids.js

# 실제 적용
DRY_RUN=false node migrations/003-upsert-unit-smartcube-ids.js
```

## 실행 순서

| 단계 | 파일 | 설명 |
|------|------|------|
| 001 | `001-init-schema.sql` | 테이블 생성 + ALTER (멱등) |
| 002 | `002-backfill-scheduled-jobs.sql` | tblScheduledJob 초기 데이터 (1회만) |
| 003 | `003-upsert-unit-smartcube-ids.js` | STG 유닛 smartcube_id 매핑 |
| 004 | `004-migrate-stg-user-ids.js` | STG 사용자 ID 매핑 |
| 005 | `005-reconcile-pti-per-unit.js` | PTI 정합성 보정 |

## 사이트-지점 매핑

| 지점 | siteId | officeCode |
|------|--------|-----------|
| 송파 | `698ed8d861c38505daecc6b4` | `001` |
| 마곡 | `69c217cd53c43d6dfe7266b0` | `002` |
| 선릉 | `698eda4461c38505daee95eb` | `003` |

새 지점 추가 시: 003 스크립트 내 `SITES` 배열에 siteId, officeCode를 추가하고 실행.

## 주의사항

1. `.env`에 DB/STG 접속 정보가 설정되어 있어야 합니다
2. JS 마이그레이션(003~005)은 개별 실행 시 기본 `DRY_RUN=true` — `npm run migrate`는 자동으로 `DRY_RUN=false`
3. 002는 멱등이 아닙니다 — 실행 전 `SELECT COUNT(*) FROM tblScheduledJob` → 0 확인
4. 마이그레이션 중 서버 중단 권장 (웹훅 수신 시 상태 불일치 가능)
5. 실행 순서: 마이그레이션 완료 → 서버 코드 배포 → 서버 시작
