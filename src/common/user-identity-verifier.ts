import type { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { normalizePhone } from './utils';

/**
 * 스케줄러/비동기 job이 실행 시점에 "같은 사용자가 여전히 이 유닛을 점유하는가"
 * 를 확인할 때 쓰는 공용 identity verifier.
 *
 * 동기 가드만으로는 다음 두 오염 패턴을 구분하지 못해 false-skip 이 발생했다:
 *   1) 레거시 PTI 중계서버가 `tblBoxMaster.userCode` 를 STG uid 대신 phone 으로
 *      덮어쓴다 (useState 업데이트와 무관하게). job.userCode(STG uid) vs
 *      row.userCode(phone) 로 mismatch 처리되어 정상 활성이 skip.
 *   2) phone 이 레거시 truncate 되어 저장돼 있고 job snapshot phone 과 달라지는 경우.
 *
 * 해결 순서:
 *   - fast-path: job.userCode / row.userCode 가 모두 STG uid 형태(phone 포맷 아님)이고
 *     서로 일치하면 바로 통과.
 *   - stg-rental: rentalId + sgApi 가 주어지면 STG 를 재조회해서 현재 ownerId 와
 *     job.userCode 를 비교한다 (source of truth). 레거시 DB 덮어쓰기에 강건.
 *   - phone-fallback: STG 재조회 불가 시 normalize 된 phone 비교.
 *   - unknown: 어느 것으로도 판정 불가 → matches=false.
 */

export interface IdentitySnapshot {
  userCode: string | null | undefined;
  userPhone: string | null | undefined;
}

export type VerifyIdentitySource =
  | 'userCode'
  | 'stg-rental'
  | 'phone'
  | 'unknown';

export interface VerifyIdentityResult {
  matches: boolean;
  source: VerifyIdentitySource;
  detail: string;
}

/** STG rental 재조회에 필요한 최소 인터페이스 — 테스트에서 mock 하기 쉽게 좁혀둔다. */
export interface IdentityStgPort {
  getUnitRental(rentalId: string): Promise<{ ownerId?: string; state?: string }>;
}

export interface VerifyIdentityOptions {
  /** STG rental ID — 있으면 STG 재조회로 source-of-truth 확인 */
  rentalId?: string | null;
  /** STG API — rentalId 와 함께 있을 때만 재조회 수행 */
  sgApi?: IdentityStgPort | StoreganiseApiService | null;
  /** 로그 포트 (선택) */
  logger?: { warn?: (msg: string) => void; log?: (msg: string) => void } | null;
}

/**
 * STG ownerId 는 24자 hex MongoDB ObjectId 패턴이고, 한국 mobile 은 `01`로 시작하는
 * 10~11자리 숫자이다. 레거시 미들웨어가 userCode 자리에 phone 을 써넣은 패턴을
 * detect 하는 데 사용 — 이 경우 해당 값은 "사용자 식별자"로 신뢰할 수 없으니
 * STG 재조회 경로로 넘긴다.
 */
export function looksLikePhoneCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^0\d{9,10}$/.test(value);
}

function isStgUid(value: string | null | undefined): boolean {
  if (!value) return false;
  return !looksLikePhoneCode(value);
}

/**
 * 두 snapshot 의 userCode 가 모두 STG uid 이고 일치하면 빠르게 통과.
 * 그 외엔 STG 재조회 또는 phone 비교로 넘긴다.
 */
export async function verifyUserIdentity(
  expected: IdentitySnapshot,
  actual: IdentitySnapshot,
  options: VerifyIdentityOptions = {},
): Promise<VerifyIdentityResult> {
  const expCode = expected.userCode?.trim() || '';
  const actCode = actual.userCode?.trim() || '';

  // 1) fast path — 양쪽 모두 phone 포맷이 아닌 userCode 를 가지고 일치
  if (expCode && actCode && isStgUid(expCode) && isStgUid(actCode)) {
    if (expCode === actCode) {
      return {
        matches: true,
        source: 'userCode',
        detail: `userCode match (${expCode})`,
      };
    }
    // 둘 다 STG uid 인데 다르다 — 진짜 사용자 변경 가능성. 그래도 STG 로 확증.
  }

  // 2) STG 재조회 — 최우선 authoritative 경로
  if (options.rentalId && options.sgApi) {
    try {
      const rental = await options.sgApi.getUnitRental(options.rentalId);
      const currentOwnerId = (rental.ownerId ?? '').trim();
      if (!currentOwnerId) {
        options.logger?.warn?.(
          `[identityVerifier] STG rental ${options.rentalId} has no ownerId (state=${rental.state ?? 'n/a'})`,
        );
        // 통과시키지 않는다 — ownerId 없는 rental 을 활성화 대상으로 간주하면 위험.
        return {
          matches: false,
          source: 'stg-rental',
          detail: `STG rental ${options.rentalId} has no ownerId`,
        };
      }
      if (expCode && currentOwnerId === expCode) {
        return {
          matches: true,
          source: 'stg-rental',
          detail: `STG confirms owner=${currentOwnerId}`,
        };
      }
      return {
        matches: false,
        source: 'stg-rental',
        detail: `STG owner changed: job=${expCode || '(none)'} stg=${currentOwnerId}`,
      };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      options.logger?.warn?.(
        `[identityVerifier] STG rental ${options.rentalId} fetch failed: ${msg} — falling back to phone`,
      );
      // STG 에러 시 phone-fallback 으로 진입 (transient 네트워크 이슈 방어)
    }
  }

  // 3) phone fallback — normalize 후 비교
  const expPhone = normalizePhone(expected.userPhone ?? '');
  const actPhone = normalizePhone(actual.userPhone ?? '');
  if (expPhone && actPhone) {
    if (expPhone === actPhone) {
      return {
        matches: true,
        source: 'phone',
        detail: `phone match (${expPhone})`,
      };
    }
    return {
      matches: false,
      source: 'phone',
      detail: `phone differs: exp=${expPhone} act=${actPhone}`,
    };
  }

  // 4) 어느 것으로도 비교 불가 — 안전하게 mismatch 처리
  return {
    matches: false,
    source: 'unknown',
    detail: 'no comparable identity available',
  };
}
