# 마이그레이션

새 중계서버 배치 시 실행이 필요한 DB 스키마 변경 및 데이터 마이그레이션.

## 한 번에 실행

```bash
npm run migrate
```

6단계를 순차 실행하며, 실패 시 중단됩니다. 로그는 `logs/migrate-*.log`에 자동 저장됩니다.
기본 30일 이상 된 로그/CSV는 자동 로테이션됩니다. `LOG_RETENTION_DAYS=0`으로 비활성 가능.

## 개별 실행

```bash
# SQL 실행 (001, 002)
node migrations/run-sql.js migrations/001-init-schema.sql

# JS 마이그레이션 (003~006) — 기본 DRY_RUN=true
node migrations/003-upsert-unit-smartcube-ids.js

# 실제 적용
DRY_RUN=false node migrations/003-upsert-unit-smartcube-ids.js
```

## 실행 순서

| 단계 | 파일 | 설명 | 멱등 |
|------|------|------|------|
| 001 | `001-init-schema.sql` | 테이블 생성 + 컬럼/인덱스 추가 | ✓ |
| 002 | `002-backfill-scheduled-jobs.sql` | tblScheduledJob 초기 데이터 | ✓ (sourceEventType='backfill' 체크) |
| 003 | `003-upsert-unit-smartcube-ids.js` | STG 유닛 smartcube_id 매핑 | ✓ |
| 004 | `004-migrate-stg-user-ids.js` | STG 사용자 ID 매핑 (rental 기반) | ✓ |
| 005 | `005-reconcile-pti-per-unit.js` | PTI 정합성 보정 | ✓ |
| 006 | `006-site-sync.js` | STG ↔ DB 전체 사이트 동기화 | ✓ |

### 004 rental 기반 동작

STG 사이트별 유닛을 순회하며 occupied 유닛의 `rental.ownerId`를 DB에 세팅합니다.
phone+name 매칭 방식 대비 장점:
- STG에 같은 사람이 여러 계정으로 등록돼 있어도 004와 006이 **동일한 stgUserId** 를 선택
- 006에서 `findExistingAccessCode`가 정확히 매칭돼 기존 AccessCode 가 보존됨

비용: STG API 를 `site×unit×rental + 고유 owner×user` 만큼 호출하므로 구버전 대비 수 분 더 소요.

## 사이트-지점 매핑

지점 정의는 `migrations/lib/sites.js` 에서 공유됩니다. 새 지점 추가 시 이 파일 하나만 수정하면
003/004/006 이 모두 반영합니다.

| 지점 | siteId | officeCode |
|------|--------|-----------|
| 송파 | `698ed8d861c38505daecc6b4` | `001` |
| 마곡 | `69c217cd53c43d6dfe7266b0` | `002` |
| 선릉 | `698eda4461c38505daee95eb` | `003` |

## 주의사항

1. `.env` 에 DB/STG 접속 정보가 설정되어 있어야 합니다
2. JS 마이그레이션(003~006)은 개별 실행 시 기본 `DRY_RUN=true` — `npm run migrate` 는 자동으로 `DRY_RUN=false`
3. 마이그레이션 중 서버 중단 권장 (웹훅 수신 시 상태 불일치 가능)
4. 실행 순서: 마이그레이션 완료 → 서버 코드 배포 → 서버 시작

## 실패 시 복구

마이그레이션은 실패한 스텝에서 중단되고 이전 스텝 변경은 유지됩니다. 각 스텝이 멱등이므로
원인을 해결한 뒤 `npm run migrate` 재실행하면 이미 반영된 부분은 skip되고 남은 단계만 진행됩니다.

심각한 데이터 손상 의심 시 복구 절차:
1. 서버 중단 (이미 중단돼 있어야 함)
2. 마이그레이션 이전 DB 스냅샷으로 복원 (DBA 담당)
3. 원인 분석 후 마이그레이션 코드 수정
4. 테스트 DB 에서 재검증 후 다시 실행

별도의 rollback 스크립트는 제공하지 않습니다 — 각 단계가 병행 실행되는 구조가 아니고,
DB 스냅샷 복원이 더 안전한 방식이라고 판단합니다.

## 로그/CSV 산출물

`logs/` 아래 각 실행마다 다음 파일 생성:

| 파일 | 내용 |
|------|------|
| `migrate-YYYYMMDD-HHmmss.log` | 전체 실행 로그 (stdout + stderr) |
| `migrate-YYYYMMDD-HHmmss-report.md` | 단계별 결과 요약 |
| `004-no-owner-*.csv` | 수동 확인: STG rental 에 ownerId 없음 |
| `006-no-smartcube-id-*.csv` | 수동 확인: smartcube_id 미설정 유닛 |
| `006-db-only-occupied-*.csv` | 수동 확인: DB 에만 입주 기록 (STG 없음) |
| `006-sync-failed-*.csv` | 수동 확인: 동기화 실패 유닛 |
