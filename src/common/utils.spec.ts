import {
  normalizePhone,
  formatName,
  formatKstDate,
  extractUserInfo,
  findJobStep,
  generateAccessCode,
  parseSmartcubeId,
  resolveUnitMapping,
} from './utils';
import type { SgUser, SgJob } from '../storeganise/storeganise-api.service';

describe('normalizePhone', () => {
  it('한국 번호 (+82) → 0으로 시작하는 형식', () => {
    expect(normalizePhone('+82 10 8569 3265')).toBe('01085693265');
  });

  it('한국 번호 (82) 공백 없이', () => {
    expect(normalizePhone('821085693265')).toBe('01085693265');
  });

  it('해외 번호는 그대로 숫자만 추출', () => {
    expect(normalizePhone('+1 555 123 4567')).toBe('15551234567');
  });

  it('빈 문자열 → 빈 문자열', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('이미 정규화된 번호', () => {
    expect(normalizePhone('01012345678')).toBe('01012345678');
  });

  it('하이픈 포함 번호', () => {
    expect(normalizePhone('010-1234-5678')).toBe('01012345678');
  });

  it('+82 뒤에 0이 유지된 케이스 → 0 중복 없이 그대로', () => {
    expect(normalizePhone('+8201053448110')).toBe('01053448110');
    expect(normalizePhone('+82 010 5344 8110')).toBe('01053448110');
  });

  it('국가코드/선행 0 모두 생략된 10자리 한국 모바일', () => {
    expect(normalizePhone('10 9770 7233')).toBe('01097707233');
    expect(normalizePhone('1058747791')).toBe('01058747791');
  });
});

describe('formatName', () => {
  it('성 + 이름 → "성, 이름"', () => {
    expect(formatName('Kim', 'Jay')).toBe('Kim, Jay');
  });

  it('성만 있는 경우', () => {
    expect(formatName('Kim', '')).toBe('Kim');
  });

  it('이름만 있는 경우', () => {
    expect(formatName('', 'Jay')).toBe('Jay');
  });

  it('둘 다 비어있으면 빈 문자열', () => {
    expect(formatName('', '')).toBe('');
  });

  it('공백 트림 처리', () => {
    expect(formatName('  Kim  ', '  Jay  ')).toBe('Kim, Jay');
  });
});

describe('formatKstDate', () => {
  it('Asia/Seoul 캘린더 기준 YYYY-MM-DD로 포맷 (서버 TZ 무관)', () => {
    // KST 2026-04-07 00:05 == UTC 2026-04-06 15:05
    expect(formatKstDate(new Date('2026-04-06T15:05:00.000Z'))).toBe(
      '2026-04-07',
    );
    // KST 2026-12-31 23:59 == UTC 2026-12-31 14:59
    expect(formatKstDate(new Date('2026-12-31T14:59:00.000Z'))).toBe(
      '2026-12-31',
    );
    // KST 2027-01-01 00:30 == UTC 2026-12-31 15:30 (날짜 경계 넘김)
    expect(formatKstDate(new Date('2026-12-31T15:30:00.000Z'))).toBe(
      '2027-01-01',
    );
  });
});

describe('extractUserInfo', () => {
  it('phone + name 추출', () => {
    const user: SgUser = {
      id: 'u1',
      phone: '+82 10 1234 5678',
      lastName: 'Kim',
      firstName: 'Jay',
    };
    expect(extractUserInfo(user)).toEqual({
      userPhone: '01012345678',
      userName: 'Kim, Jay',
    });
  });

  it('phone 없으면 mobile fallback', () => {
    const user: SgUser = {
      id: 'u1',
      mobile: '+82 10 9999 8888',
      lastName: 'Park',
      firstName: '',
    };
    expect(extractUserInfo(user)).toEqual({
      userPhone: '01099998888',
      userName: 'Park',
    });
  });

  it('phone, mobile 모두 없으면 빈 문자열', () => {
    const user: SgUser = { id: 'u1' };
    expect(extractUserInfo(user)).toEqual({
      userPhone: '',
      userName: '',
    });
  });
});

describe('findJobStep', () => {
  const job: SgJob = {
    id: 'j1',
    type: 'unit_moveIn',
    steps: [
      {
        id: 's1',
        type: 'start',
        state: 'completed',
        result: { unitRentalId: 'r1' },
      },
      { id: 's2', type: 'confirmMovedOut', state: 'pending' },
    ],
  };

  it('타입으로 step 찾기', () => {
    const step = findJobStep(job, 'start');
    expect(step).toBeDefined();
    expect(step!.id).toBe('s1');
    expect(step!.result?.unitRentalId).toBe('r1');
  });

  it('없는 타입이면 undefined', () => {
    expect(findJobStep(job, 'nonexistent')).toBeUndefined();
  });

  it('steps가 없는 job', () => {
    const emptyJob: SgJob = { id: 'j2', type: 'test' };
    expect(findJobStep(emptyJob, 'start')).toBeUndefined();
  });
});

describe('generateAccessCode', () => {
  it('기본 6자리 숫자 생성', () => {
    const code = generateAccessCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(Number(code)).toBeGreaterThanOrEqual(100000);
    expect(Number(code)).toBeLessThan(1000000);
  });

  it('4자리 생성', () => {
    const code = generateAccessCode(4);
    expect(code).toMatch(/^\d{4}$/);
  });

  it('8자리 생성', () => {
    const code = generateAccessCode(8);
    expect(code).toMatch(/^\d{8}$/);
  });

  it('매 호출마다 다른 값 (확률적)', () => {
    const codes = new Set(
      Array.from({ length: 20 }, () => generateAccessCode()),
    );
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('parseSmartcubeId', () => {
  it('정상 파싱 "0001:1214"', () => {
    expect(parseSmartcubeId('0001:1214')).toEqual({
      groupCode: '0001',
      showBoxNo: 1214,
    });
  });

  it('null → null', () => {
    expect(parseSmartcubeId(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(parseSmartcubeId(undefined)).toBeNull();
  });

  it('빈 문자열 → null', () => {
    expect(parseSmartcubeId('')).toBeNull();
  });

  it('구분자 없음 → null', () => {
    expect(parseSmartcubeId('nodelimiter')).toBeNull();
  });

  it('showBoxNo가 숫자가 아님 → null', () => {
    expect(parseSmartcubeId('0001:abc')).toBeNull();
  });
});

describe('resolveUnitMapping', () => {
  const mockSgApi = {
    getOfficeCode: jest.fn().mockResolvedValue('0001'),
  };

  beforeEach(() => {
    mockSgApi.getOfficeCode.mockClear();
  });

  it('정상 매핑: siteId + smartcube_id → areaCode, showBoxNo, officeCode', async () => {
    const unit = {
      siteId: 'site1',
      customFields: { smartcube_id: '0002:5' },
    };

    const result = await resolveUnitMapping(mockSgApi, unit);
    expect(result).toEqual({
      areaCode: 'strh0010002',
      showBoxNo: 5,
      officeCode: '0001',
    });
    expect(mockSgApi.getOfficeCode).toHaveBeenCalledWith('site1');
  });

  it('smartcube_id 없으면 null', async () => {
    const unit = { siteId: 'site1', customFields: {} };
    expect(await resolveUnitMapping(mockSgApi, unit)).toBeNull();
  });

  it('siteId 없으면 null', async () => {
    const unit = { customFields: { smartcube_id: '0001:1' } };
    expect(await resolveUnitMapping(mockSgApi, unit)).toBeNull();
  });

  it('smartcube_id 형식 오류면 null', async () => {
    const unit = { siteId: 'site1', customFields: { smartcube_id: 'invalid' } };
    expect(await resolveUnitMapping(mockSgApi, unit)).toBeNull();
  });
});
