import { randomInt } from 'crypto';
import type {
  SgUser,
  SgJob,
  SgJobStep,
} from '../storeganise/storeganise-api.service';

/**
 * SG 전화번호 → MSSQL 형식 변환
 * "+82 10 8569 3265" → "01085693265"
 * "+82010XXXXYYYY"   → "010XXXXYYYY" (국가코드 뒤에 0이 유지된 케이스)
 * "10 8569 3265"     → "01085693265" (국가코드/선행 0 모두 생략된 한국 모바일)
 * "+1 555 123 4567"  → "15551234567"
 */
export function normalizePhone(sgPhone: string): string {
  if (!sgPhone) return '';
  const digits = sgPhone.replace(/\D/g, '');
  // 국가코드 82: 뒤에 0이 이미 있으면 그대로, 없으면 0 추가
  if (digits.startsWith('82')) {
    const tail = digits.slice(2);
    return tail.startsWith('0') ? tail : '0' + tail;
  }
  // 선행 0 누락된 한국 모바일 (10X XXXX XXXX 형식, 10자리)
  if (/^10\d{8}$/.test(digits)) {
    return '0' + digits;
  }
  return digits;
}

/**
 * SG 이름 → MSSQL 형식 변환
 * {lastName: "Kim", firstName: "Jay"} → "Kim, Jay"
 */
export function formatName(lastName: string, firstName: string): string {
  const last = (lastName ?? '').trim();
  const first = (firstName ?? '').trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || '';
}

const KST_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Date → Asia/Seoul (KST) 캘린더 기준 YYYY-MM-DD.
 * 서버 프로세스의 TZ 설정과 무관하게 항상 KST 기준 날짜를 반환한다.
 */
export function formatKstDate(date: Date): string {
  const parts = KST_DATE_FORMATTER.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

/**
 * SgUser에서 전화번호 + 이름 추출 및 정규화
 */
export function extractUserInfo(user: SgUser): {
  userPhone: string;
  userName: string;
} {
  const rawPhone = user.phone ?? user.mobile ?? '';
  const userPhone = normalizePhone(rawPhone);
  const userName = formatName(user.lastName ?? '', user.firstName ?? '');
  return { userPhone, userName };
}

/**
 * SgJob에서 특정 타입의 step 탐색
 */
export function findJobStep(
  job: SgJob,
  stepType: string,
): SgJobStep | undefined {
  return (job.steps ?? []).find((s) => s.type === stepType);
}

/**
 * PIN 코드 생성 (4~8자리 숫자)
 */
export function generateAccessCode(length = 6): string {
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  return String(randomInt(min, max));
}

/**
 * smartcube_id 파싱
 * 형식: "0001:1214" → { groupCode: "0001", showBoxNo: 1214 }
 * 뒤의 숫자는 STG unit.name과 일치하는 showBoxNo이며, 호호락 내부 boxNo가 아니다.
 */
export function parseSmartcubeId(
  id: string | undefined | null,
): { groupCode: string; showBoxNo: number } | null {
  if (!id) return null;
  const sep = id.lastIndexOf(':');
  if (sep === -1) return null;
  const groupCode = id.slice(0, sep);
  const showBoxNo = parseInt(id.slice(sep + 1), 10);
  if (!groupCode || isNaN(showBoxNo)) return null;
  return { groupCode, showBoxNo };
}

/**
 * STG unit → { areaCode, showBoxNo, officeCode } 매핑
 * unit.siteId → site.smartcube_siteCode(officeCode) 조회
 * unit.smartcube_id("0001:1214") 파싱 → showBoxNo
 * → areaCode = "strh" + officeCode + groupCode
 */
export async function resolveUnitMapping(
  sgApi: { getOfficeCode(siteId: string): Promise<string> },
  unit: {
    siteId?: string;
    customFields?: Record<string, unknown>;
    [key: string]: unknown;
  },
): Promise<{ areaCode: string; showBoxNo: number; officeCode: string } | null> {
  const smartcubeId = unit.customFields?.smartcube_id as string | undefined;
  const parsed = parseSmartcubeId(smartcubeId);
  if (!parsed) return null;

  const siteId = unit.siteId;
  if (!siteId) return null;

  const officeCode = await sgApi.getOfficeCode(siteId); // 4자리 (e.g., '0003')
  const areaCodePrefix = officeCode.replace(/^0/, ''); // 3자리 (e.g., '003')
  const areaCode = 'strh' + areaCodePrefix + parsed.groupCode;

  return { areaCode, showBoxNo: parsed.showBoxNo, officeCode };
}
