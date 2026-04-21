# SmartCube Sync Server — 사용자 가이드

> Storeganise(STG) ↔ 호호락 MSSQL 동기화 NestJS 백엔드. STG webhook 을 받아
> DB 상태를 갱신하고, 대시보드에서 결과를 실시간으로 확인합니다.
>
> 본 문서는 운영자가 서버를 설치·구동·관리하기 위한 전 과정을 담은 사용자 가이드입니다.

## 기능

- `POST /webhook` — Storeganise webhook 수신 + 처리 (입주/퇴거/이관/Overlock/AccessCode)
- `GET /monitoring` — 운영 대시보드 (세션 로그인)
- `/api-docs` — API 명세 (Swagger UI)
- 스케줄러 — 입주 활성화 / 퇴거 차단 자동 실행
- 재시도 — 웹훅/스케줄 실패 시 3회 비동기 재시도 (1분 / 5분 / 15분)
- 실패 알림 — 최종 실패 시 SMTP 이메일 발송

## 시스템 요구사항

- Windows 10 / 11 (x64)
- 호호락 MSSQL 접근 가능
- Storeganise API 접근 가능 (webhook 수신 URL 이 STG 에 등록돼 있어야 함)
- SMTP 서버 (실패 알림)
- **Node.js 는 release 패키지에 포함**되어 있어 별도 설치 불필요

## 설치

1. `release.zip` 을 원하는 경로에 압축 해제 (예: `C:\smartcube`)
2. 해당 폴더의 `.env` 파일을 텍스트 에디터로 열어 프로덕션 값으로 교체

```env
# 서버
PORT=4100

# MSSQL 데이터베이스
DB_HOST=110.10.147.85
DB_PORT=1049
DB_USER=SMTUser
DB_PASSWORD=SMTUserPass
DB_NAME=HOHO_LOCK_STRH

# Storeganise API
SG_BASE_URL=https://storhub-kr.storeganise.com/api
SG_API_KEY=mG-o6HsC0LywwGFwqIiAjpWFbSZS_k7H-BYecHiXwiSESAmZ5bDnhV2lKdI-YOIh
SG_WEBHOOK_SECRET=wBajjl9xXzG-aOP_R5sXj5cnOx52_6OEPT5rHiOcfoM

# 실패 알림 이메일 (SMTP)
SMTP_HOST=smtp.daum.net                             # 예: smtp.kakao.com
SMTP_PORT=465                                       # 465=SSL, 587=STARTTLS
SMTP_USER=ejunokl                                   # SMTP 로그인 계정
SMTP_PASS=fghldbhvvlntmofq                          # SMTP 비밀번호 또는 앱 비밀번호
SMTP_FROM=SmartCube Alerts <ejunokl@daum.net>       # 예: SmartCube Alerts <alerts@example.com>

# HTTPS (선택) — 설정 시 NestJS 가 직접 TLS 종단. 없으면 HTTP 폴백.
SSL_KEY=C:\Bitnami\wampstack-5.6.29-1\apache2\conf\key\wildcard_hoholock_co_kr__key.pem
SSL_CERT=C:\Bitnami\wampstack-5.6.29-1\apache2\conf\key\wildcard_hoholock_co_kr__crt.pem
```

> `DB_*`, `SG_*`, `SMTP_*` 는 프로덕션 환경 값으로 반드시 교체하세요.
> `SG_WEBHOOK_SECRET` 은 STG 에 등록된 서명 비밀과 일치해야 웹훅이 수락됩니다.

## 서버 관리

| 동작 | 명령 |
|------|------|
| 시작 | `start-server.bat` 더블클릭 |
| 중지 | `stop-server.bat` 더블클릭 |
| 재시작 | `stop-server.bat` 후 `start-server.bat` |
| 상태 확인 | `status-server.bat` 더블클릭 (PM2 프로세스 목록 + 상태) |
| PM2 에서 제거 | `clear-server.bat` 더블클릭 (`smartcube-sync` 등록 해제) |

`start-server.bat` 은 PM2 에 `smartcube-sync` 라는 이름으로 프로세스를 등록하고
실행 상태를 출력합니다. PM2 는 release 폴더 안의 Node.js 포터블(`.node`) 과
`node_modules/pm2` 를 그대로 사용합니다.

### 상태 / 로그 확인

PowerShell 또는 cmd 에서 release 폴더로 이동 후:

```
set PATH=%CD%\.node;%PATH%
node node_modules\pm2\bin\pm2 status
node node_modules\pm2\bin\pm2 logs smartcube-sync
```

일상 운영 중 로그 확인은 **모니터링 대시보드** 를 먼저 이용하세요. OS 레벨 로그
확인은 프로세스 충돌이나 부팅 실패 등 PM2 status 가 이상할 때만 필요합니다.

## 모니터링 대시보드

### 로그인

호호락 관리자 계정(`tblMgrAccnt`)으로 로그인합니다. 별도 계정 발급 없이 기존
운영자 계정을 그대로 사용하세요. 세션은 24시간 유지되며 요청마다 자동 갱신됩니다.

### 핵심 기능

| 영역 | 용도 |
|------|------|
| 좌측 실시간 피드 | 웹훅/스케줄러가 발생시키는 모든 sync 이벤트를 실시간 스트림 |
| 필터바 | source / status / 지점 / 검색어로 좁혀 보기 |
| 우측 pending 패널 | `tblScheduledJob` 의 대기 작업 (예: 입주 활성화 대기) |
| 지점 그리드 | STG 기준 / 호호락 DB 기준 유닛 상태 토글 뷰, 불일치 발견 시 동기화 실행 |
| 실패 로그 | `status=error` 건 재처리 버튼 — 원 핸들러를 재실행해 새 sync 로그 생성 |
| 사이트 동기화 | 지점 단위 STG↔DB 전체 재동기화 (백그라운드 job, SSE 진행 구독) |
| 사용자 동기화 | `tblPTIUserInfo` / `tblBoxMaster` 사용자 정보 일괄 재동기화 |

## HTTPS (선택)

STG 는 `https://` URL 로만 webhook 을 발송합니다. 기본 구성은 NestJS 가 HTTP
(4100 포트) 로 listening 하므로, 외부 공개 시에는 TLS 종단이 필요합니다. 두 가지 선택지:

### 방식 A — IIS 등 기존 리버스 프록시 사용

운영 서버에 이미 IIS + ARR/URL Rewrite 가 다른 서비스(예: 3200 포트) 에 인증서를
서빙 중이면, 같은 IIS 에 새 사이트(bindings: https 443, SNI 체크)를 추가하고
`http://localhost:4100` 으로 프록시하면 됩니다. WebSocket 활성화 필요 (SSE 지원).

### 방식 B — NestJS 자체 HTTPS + PM2 주기 재시작 (인프라 의존 최소)

1. `.env` 에 인증서 경로 설정 (현재 운영: Apache 와일드카드 인증서 공유):
   ```
   SSL_KEY=C:\Bitnami\wampstack-5.6.29-1\apache2\conf\key\wildcard_hoholock_co_kr__key.pem
   SSL_CERT=C:\Bitnami\wampstack-5.6.29-1\apache2\conf\key\wildcard_hoholock_co_kr__crt.pem
   ```
   (윈도우 .pfx 환경이면 `SSL_PFX` + `SSL_PASS` 사용, PFX 가 있으면 KEY/CERT 무시)

2. `ecosystem.config.js` 의 `cron_restart: '0 3 * * *'` — 매일 새벽 3시 자동 재시작.
   PM2 가 프로세스를 kill 후 재기동하면 `main.ts` 의 `buildHttpsOptions()` 가 인증서
   파일을 다시 읽어 새 TLS 컨텍스트로 교체합니다. moveIn.activate(00:00) /
   moveOut.block(23:59:59) 스케줄러와 겹치지 않는 안전 구간.

3. 인증서 갱신은 `win-acme`(윈도우) 또는 `certbot`(리눅스) 로 자동화. 갱신 직후
   바로 반영하려면 win-acme 의 post-request script 로 `pm2 restart smartcube-sync`
   지정.

4. 인증서 파일 로드 실패 시 부팅을 막지 않고 경고 후 HTTP 로 폴백 — 한밤중 갱신
   실패로 스케줄러가 멈추는 상황 방지. 다만 이 상태면 외부 webhook 은 TLS 불일치로
   실패하므로 `pm2 logs` 의 `HTTPS options load failed` 경고를 모니터링하세요.

## 업데이트 배포

새 `release.zip` 수령 시:

1. `stop-server.bat` 으로 서버 중지
2. 기존 release 폴더의 `.env` 를 별도 위치로 백업
3. 새 release.zip 을 같은 위치에 압축 해제 (덮어쓰기)
4. 백업해둔 `.env` 를 새 폴더로 복사
5. `start-server.bat` 으로 재시작
6. 대시보드에서 피드가 다시 흐르는지 확인

> `.sessions.json` (세션 파일) 은 덮어쓰기 하지 마세요 — 로그인이 풀립니다.

## 마이그레이션 (스키마 변경 포함 버전 받을 때만)

```
npm run migrate
```

DB 스키마 생성 + 데이터 마이그레이션을 순차 실행합니다. 상세는
[`migrations/README.md`](../migrations/README.md) 참조. **납품 초기 설정과 스키마 변경을
포함한 버전 업데이트 시 개발사가 직접 실행**합니다.

## 개발

```
npm run build        # 빌드 (nest build)
npm run start:dev    # 개발 서버 (watch)
npm test             # 유닛 테스트
npm run lint         # 린트
```

## 통합 명세 (납품 인계용)

- **DB 추가 스키마/마이그레이션**: [`migrations/README.md`](../migrations/README.md) — 신규 테이블/컬럼/마이그레이션 5단계 (지점별 `--offices` 옵션 지원)
- **STG 커스텀 필드 contract**: [`STG_Custom_Fields.md`](STG_Custom_Fields.md) — Storeganise `customFields` 에 sync server 가 정의/사용하는 필드 명세 (owner / reader / trigger)
- **API 명세**: 서버 실행 후 `/api-docs` (Swagger UI)
