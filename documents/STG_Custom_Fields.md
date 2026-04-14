# STG Custom Fields Reference

SmartCube Sync Server 가 Storeganise(STG) 의 `customFields` 영역에 정의/사용하는 필드 명세.
다른 통합 시스템이 같은 이름을 임의로 set/clear 하면 동작이 깨질 수 있으므로, **owner 가
누구인지** 가 핵심 포인트다.

## 표기 규약

| 컬럼 | 의미 |
|------|------|
| 필드 | STG `customFields.<key>` 의 key |
| 타입 | JSON 타입 |
| Owner | 값을 권한있게 설정하는 주체 — `Server` (sync server) / `Ops` (운영자/STG admin UI) |
| Reader | 값을 읽어 판단에 사용하는 주체 |
| 트리거 | 값 변경이 webhook 으로 sync server 에 도달했을 때 발생하는 동작 |

값은 webhook `unit.updated` / `unitRental.updated` 의 `data.changedKeys` 로 변경이 통보된다.
`changedKeys` 에 해당 필드 경로가 포함돼 있을 때만 sync server 가 분기를 실행한다.

---

## Unit (`/v1/admin/units/:id`)

| 필드 | 타입 | Owner | Reader | 트리거 |
|------|------|-------|--------|--------|
| `smartcube_id` | `string` | Server | Server | 매핑 키. 형식 `"<officeCode>:<showBoxNo>"` (예: `"001:101"`). 마이그레이션 003 단계에서 STG unit 마다 채워지며, 이후 sync server 가 수동 변경하지 않는다. **Ops 는 절대 변경 금지** — 매핑이 깨지면 모든 동기화 실패 |
| `smartcube_syncUnit` | `boolean` | Ops → Server | Server | Ops 가 `true` 로 set → server 가 해당 unit 한 건 동기화 (입주/퇴거/PIN/Overlock 상태 재반영) → 완료 후 server 가 `false` 로 reset. `smartcube_id` 가 없으면 동기화 skip 후 reset 만 |

---

## UnitRental (`/v1/admin/unit-rentals/:id`)

| 필드 | 타입 | Owner | Reader | 트리거 |
|------|------|-------|--------|--------|
| `gate_code` | `string` (4~8 숫자) | Server | Ops | 게이트 PIN. 호호락 통합매니저 `PUT /api/access-code` 또는 `smartcube_generateAccessCode` 플로우로 server 가 set. Ops/외부 시스템 변경은 의도되지 않음 (변경 webhook 은 현재 무시) |
| `smartcube_generateAccessCode` | `boolean` | Ops → Server | Server | Ops 가 `true` 로 set → server 가 해당 office 내 unique PIN 생성 → DB(`tblPTIUserInfo`) 저장 → 같은 user 의 같은 office 모든 rental 의 `gate_code` 에 push → 완료 후 트리거 rental 만 `false` 로 reset |
| `smartcube_lockUnit` | `boolean` | Ops → Server | Server | Ops 가 `true` 로 set → server 가 unit overlock 처리 (DB `useState=3, isOverlocked=1` + 그룹 게이트 차단) → 완료 후 `false` 로 reset. `smartcube_lockStatus` 도 함께 갱신 |
| `smartcube_unlockUnit` | `boolean` | Ops → Server | Server | Ops 가 `true` 로 set → server 가 overlock 해제 (DB `useState=1, isOverlocked=0`, 그룹 내 다른 overlock 없으면 게이트 재개방) → 완료 후 `false` 로 reset |
| `smartcube_lockStatus` | `string` | Server | Ops | overlock 진행 상태. server 가 set, Ops read 전용. 값: `"in progress"` (처리 중) / `"overlocked"` (활성) / `"overlock removed"` (해제 완료) |

---

## 동시 변경 / 충돌 룰

- `smartcube_lockUnit` 과 `smartcube_unlockUnit` 이 동시에 `true` → server 가 둘 다 `false` 로 reset 후 무동작
- `smartcube_lockStatus === "in progress"` 상태에서 새 lock/unlock 요청 → server 가 무시 (중복 처리 방지)
- 어떤 필드든 `smartcube_id` 가 없으면 server 는 softError 로 syncLog 에 기록하고 webhook 200 OK 응답
- webhook 처리 실패 시 server 는 자동 재시도 (1분/5분/15분, 총 3회) — 그동안 STG 의 `lockStatus` 는 `"in progress"` 로 머묾

---

## Ops 운영 가이드

**Ops 가 set 해도 되는 필드** (트리거 의도):
- `smartcube_syncUnit` (Unit)
- `smartcube_generateAccessCode` (Rental)
- `smartcube_lockUnit` / `smartcube_unlockUnit` (Rental)

**Ops 가 set 하면 안 되는 필드** (server 만 변경):
- `smartcube_id` (매핑 key — 변경 시 동기화 영구 망가짐)
- `gate_code` (호호락 → STG 단방향)
- `smartcube_lockStatus` (server 의 progress 반영)

---

## 예시 webhook payload

`unitRental.updated` 가 lock 요청을 통보하는 예:

```json
{
  "type": "unitRental.updated",
  "id": "evt_abc123",
  "businessCode": "<biz>",
  "data": {
    "unitRentalId": "rnt_xxx",
    "changedKeys": ["customFields.smartcube_lockUnit"]
  }
}
```

server 는 `changedKeys` 에 포함된 키만 보고 동작을 결정한다. `customFields` 의 현재 값은
`/v1/admin/unit-rentals/:id` 를 다시 조회해 가져온다.

---

## 관련 문서

- DB 스키마/테이블 추가 명세: [`../migrations/README.md`](../migrations/README.md)
- API 명세: 운영 서버의 `/api-docs` (Swagger UI)
