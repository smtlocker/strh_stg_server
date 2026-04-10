# SmartCube Sync Server

Storeganise ↔ MSSQL 동기화를 담당하는 NestJS 백엔드입니다.

## 기능

- `POST /webhook` — Storeganise 웹훅 수신 + 처리
- `GET /monitoring` — 모니터링 대시보드 (세션 인증)
- 스케줄러 — 입주 활성화 / 퇴거 차단 자동 실행
- 웹훅 재시도 — 실패 시 3회 비동기 재시도 (1분/5분/15분)
- 실패 알림 — 최종 실패 시 SMTP 이메일 발송

## 초기 설치 (Windows)

`setup.bat` 더블클릭 — Node.js 포터블 설치, 의존성 설치, 빌드까지 자동 실행.

완료 후 `.env` 파일을 열어 값을 확인합니다. 기본값은 테스트 환경입니다.

> **프로덕션 배포 시 반드시 `DB_*`, `SG_*`, `SMTP_*` 값을 프로덕션 환경으로 교체하세요.**

```env
# 서버
PORT=4100

# MSSQL 데이터베이스
DB_HOST=
DB_PORT=1433
DB_USER=
DB_PASSWORD=
DB_NAME=

# Storeganise API
SG_BASE_URL=
SG_API_KEY=
SG_WEBHOOK_SECRET=

# 실패 알림 이메일 (SMTP)
FAILURE_ALERT_ENABLED=true
SMTP_HOST=           # 예: smtp.kakao.com
SMTP_PORT=465        # 465=SSL, 587=STARTTLS
SMTP_USER=           # SMTP 로그인 계정
SMTP_PASS=           # SMTP 비밀번호 또는 앱 비밀번호
SMTP_FROM=           # 예: SmartCube Alerts <alerts@example.com>
```

## 서버 시작 / 중지

```
start-server.bat   — PM2로 서버 시작
stop-server.bat    — PM2로 서버 중지
```

## 마이그레이션

```bash
npm run migrate
```

DB 스키마 생성 + 데이터 마이그레이션을 순차 실행합니다. 상세는 `migrations/README.md` 참조.

## 개발

```bash
npm run build        # 빌드
npm run start:dev    # 개발 서버 (watch)
npm test             # 유닛 테스트
npm run lint         # 린트
```

## 모니터링

`http://localhost:<PORT>/monitoring` — 세션 로그인 후 접속.

- 실시간 동기화 로그 피드
- 지점별 필터링
- 에러 재처리
- 사이트/사용자 전체 동기화
