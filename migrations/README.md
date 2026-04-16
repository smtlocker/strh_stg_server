# 마이그레이션

새 중계서버 배치 시 실행이 필요한 DB 스키마 변경 및 데이터 마이그레이션.

## 한 번에 실행

```bash
npm run migrate
```

5단계를 순차 실행하며, 실패 시 중단됩니다. 로그는 `logs/migrate-*.log`에 자동 저장됩니다.
기본 30일 이상 된 로그/CSV는 자동 로테이션됩니다. `LOG_RETENTION_DAYS=0`으로 비활성 가능.

## 개별 실행

```bash
# SQL 실행 (001)
node migrations/run-sql.js migrations/001-init-schema.sql

# JS 마이그레이션 (002~005) — 기본 DRY_RUN=true
node migrations/002-upsert-unit-smartcube-ids.js

# 실제 적용
DRY_RUN=false node migrations/002-upsert-unit-smartcube-ids.js
```

### Windows PowerShell

PowerShell 에서는 환경변수 주입 문법이 다릅니다.

```powershell
# 실제 적용
$env:DRY_RUN="false"; node migrations/002-upsert-unit-smartcube-ids.js

# 지점 제한과 함께
$env:DRY_RUN="false"; node migrations/003-migrate-stg-user-ids.js --offices 0002

# npm run migrate 로 전체 실행
$env:DRY_RUN="false"; npm run migrate -- --offices 0002
```

`$env:DRY_RUN` 은 현재 PowerShell 세션에서만 유지됩니다. 새 창을 열면 다시 설정해야 합니다.

## 실행 순서

| 단계 | 파일 | 설명 | 멱등 |
|------|------|------|------|
| 001 | `001-init-schema.sql` | 테이블 생성 + 컬럼/인덱스 추가 | ✓ |
| 002 | `002-upsert-unit-smartcube-ids.js` | STG 유닛 smartcube_id 매핑 | ✓ |
| 003 | `003-migrate-stg-user-ids.js` | STG 사용자 ID 매핑 (rental 기반) | ✓ |
| 004 | `004-reconcile-pti-per-unit.js` | PTI 정합성 보정 | ✓ |
| 005 | `005-site-sync.js` | STG ↔ DB 전체 사이트 동기화 + 스케줄 재구축 | ✓ |

### 003 rental 기반 동작

STG 사이트별 유닛을 순회하며 occupied 유닛의 `rental.ownerId`를 DB에 세팅합니다.
phone+name 매칭 방식 대비 장점:
- STG에 같은 사람이 여러 계정으로 등록돼 있어도 003과 005가 **동일한 stgUserId** 를 선택
- 005에서 `findExistingAccessCode`가 정확히 매칭돼 기존 AccessCode 가 보존됨

비용: STG API 를 `site×unit×rental + 고유 owner×user` 만큼 호출하므로 구버전 대비 수 분 더 소요.

## 사이트-지점 매핑

지점 정의는 **STG `/v1/admin/sites?include=customFields`** 로 런타임 조회합니다.
각 site 의 `customFields.smartcube_siteCode` (4자리 문자열) 가 `officeCode` 로 사용됩니다.
- 하드코딩 없음 — `migrations/lib/sites.js` 는 STG 에서 매번 fetch
- 새 지점은 STG 콘솔에서 해당 site 의 `customFields.smartcube_siteCode` 를 설정하면 자동 포함
- `customFields.smartcube_siteCode` 가 설정되지 않은 site 는 마이그레이션 대상에서 제외

> DB `tblBoxMaster.areaCode` 는 레거시 포맷 `strh<3자리officeCode><4자리groupCode>` 를 유지합니다.
> 코드 내부는 4자리(`"0001"`), DB 쿼리는 3자리(`"001"`) 를 `toDbOfficeCode()` 로 변환해 사용합니다.

## 지점별 선택 실행

특정 지점만 마이그레이션하고 그 결과만 확인하고 싶을 때 `--offices` CLI 인자를 사용합니다.

```bash
# 마곡 한 지점만 (smartcube_siteCode = 0002)
npm run migrate -- --offices 0002

# 송파 + 선릉
npm run migrate -- --offices 0001,0003

# 개별 스크립트도 동일한 인자를 받음
DRY_RUN=false node migrations/002-upsert-unit-smartcube-ids.js --offices 0002
```

동작:

- `--offices` 값은 **4자리 officeCode** (`smartcube_siteCode` 와 같은 값). 쉼표 구분.
- **002 / 003 / 005** — `lib/sites.js` 가 STG 에서 매칭 site 만 반환하므로 loop 자체가 좁아집니다.
- **004** — `tblBoxMaster` / `tblPTIUserInfo` 쿼리 WHERE 절에 `areaCode LIKE 'strh<3자리>%'` 와
  `OfficeCode IN (...)` 필터가 붙어 다른 지점 PTI 는 건드리지 않습니다. (`tblBoxMaster.areaCode`
  는 3자리 레거시, `tblPTIUserInfo.OfficeCode` 는 4자리 — 두 컬럼 자릿수가 다름.)
- **001 (스키마 생성)** — 지점 무관. 항상 전체 실행.
- **알 수 없는 officeCode** (예: `--offices 9999`) 를 넘기면 즉시 throw 후 중단됩니다.
- STG 에서 `customFields.smartcube_siteCode` 가 설정된 site 가 하나도 없으면 throw.

## 특정 유닛 단위 실행

일부 유닛만 마이그레이션이 누락됐을 때 **003 / 004 / 005** 를 해당 유닛으로 제한해 재실행할 수 있습니다.
`--units` 인자는 `<officeCode>:<groupCode>:<showBoxNo>` 포맷을 쉼표로 구분해 받습니다.

```bash
# 단일 유닛
DRY_RUN=false node migrations/003-migrate-stg-user-ids.js --units 0010:0001:1075
DRY_RUN=false node migrations/004-reconcile-pti-per-unit.js --units 0010:0001:1075
DRY_RUN=false node migrations/005-site-sync.js --units 0010:0001:1075

# 여러 유닛 (다지점 혼합 가능)
DRY_RUN=false node migrations/005-site-sync.js \
  --units 0010:0001:1075,0010:0001:1317,0003:0001:1504
```

### PowerShell 예시

```powershell
$env:DRY_RUN="false"; node migrations/003-migrate-stg-user-ids.js --units 0010:0001:1075
$env:DRY_RUN="false"; node migrations/005-site-sync.js --units 0010:0001:1075,0010:0001:1317
```

### 동작

- **003 / 005** — STG 유닛 loop 중 `--units` 의 (officeCode, groupCode, showBoxNo) 에 매칭되는 것만 처리. 나머지는 `stats.filtered` 로 집계.
- **004** — 지정 유닛이 속한 **사용자 group 전체** 를 reconcile 대상으로 확장. 예: `--units 0010:0001:1002` 로 실행해도 그 사용자가 3개 유닛 소유 중이면 3개 모두 PTI 정리. 정합성 보장 목적.
- `--offices` 는 `--units` 지정 시 역산되어 함께 쓸 필요 없습니다.
- **001 / 002** 는 `--units` 지원 안 함 (의미 없음) — 필요하면 002 를 `--offices` 로 먼저 돌려 smartcube_id 매핑을 선행하세요.
- `migrate-all.js` 는 `--units` 를 전달하지 않습니다. 개별 스크립트를 직접 실행하세요.

### 사용 시나리오

```bash
# 특정 유닛이 sync 안 됐을 때 3/4/5 를 순차 재실행
DRY_RUN=true node migrations/003-migrate-stg-user-ids.js --units 0010:0001:1075
DRY_RUN=true node migrations/004-reconcile-pti-per-unit.js --units 0010:0001:1075
DRY_RUN=true node migrations/005-site-sync.js --units 0010:0001:1075

# 문제 없으면 DRY_RUN=false 로 재실행
DRY_RUN=false node migrations/003-migrate-stg-user-ids.js --units 0010:0001:1075
DRY_RUN=false node migrations/004-reconcile-pti-per-unit.js --units 0010:0001:1075
DRY_RUN=false node migrations/005-site-sync.js --units 0010:0001:1075
```

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
| `002-no-match-*.csv` | 수동 확인: STG 유닛 ↔ DB `tblShowBoxNoDispInfo` 매핑 실패 |
| `003-no-owner-*.csv` | 수동 확인: STG rental 에 ownerId 없음 |
| `005-no-smartcube-id-*.csv` | 수동 확인: smartcube_id 미설정 유닛 |
| `005-db-only-occupied-*.csv` | 수동 확인: DB 에만 입주 기록 (STG 없음) |
| `005-sync-failed-*.csv` | 수동 확인: 동기화 실패 유닛 |
