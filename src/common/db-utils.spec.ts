const queries: string[] = [];
const inputs: Record<string, unknown>[] = [];

jest.mock('mssql', () => {
  class MockRequest {
    private captured: Record<string, unknown> = {};
    input(name: string, _type: unknown, value: unknown) {
      this.captured[name] = value;
      return this;
    }
    async query(text: string) {
      queries.push(text);
      inputs.push({ ...this.captured });
      return { rowsAffected: [1], recordset: [] };
    }
  }
  return {
    Request: MockRequest,
    Transaction: class {},
    NVarChar: 'NVarChar',
    Int: 'Int',
    TinyInt: 'TinyInt',
    Bit: 'Bit',
  };
});

import { parseAreaCodeParts, upsertPtiUserForUnit } from './db-utils';

describe('parseAreaCodeParts', () => {
  it('"strh0010001" (11자리) → officeCode="0001", groupCode="0001"', () => {
    expect(parseAreaCodeParts('strh0010001')).toEqual({
      officeCode: '0001',
      groupCode: '0001',
    });
  });

  it('"strh0020003" → officeCode="0002", groupCode="0003"', () => {
    expect(parseAreaCodeParts('strh0020003')).toEqual({
      officeCode: '0002',
      groupCode: '0003',
    });
  });

  it('"strh0030001" → officeCode="0003", groupCode="0001"', () => {
    expect(parseAreaCodeParts('strh0030001')).toEqual({
      officeCode: '0003',
      groupCode: '0001',
    });
  });

  it('짧은 문자열 → padStart 적용', () => {
    const result = parseAreaCodeParts('str');
    expect(result.officeCode).toBe('0000');
    expect(result.groupCode).toBe('');
  });
});

describe('upsertPtiUserForUnit', () => {
  beforeEach(() => {
    queries.length = 0;
    inputs.length = 0;
  });

  const baseParams = {
    areaCode: 'strh0010001',
    showBoxNo: 1,
    userPhone: '01011112222',
    userName: 'Test User',
    accessCode: '123456',
    enable: 1 as const,
    stgUserId: '698e000000000000000000aa',
  };

  it('stgUserId 가 있으면 cleanup DELETE 를 UPDATE 이전에 실행', async () => {
    await upsertPtiUserForUnit({} as never, baseParams);

    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]).toContain('DELETE FROM tblPTIUserInfo');
    expect(queries[0]).toMatch(/StgUserId IS NULL OR StgUserId = ''/);
    expect(queries[1]).toContain('UPDATE pti');
  });

  it('cleanup DELETE 는 해당 유닛 스코프로만 수행', async () => {
    await upsertPtiUserForUnit({} as never, baseParams);

    expect(inputs[0]).toMatchObject({
      officeCode: '0001',
      areaCode: 'strh0010001',
      showBoxNo: 1,
    });
  });

  it('stgUserId 가 없으면 cleanup DELETE 생략', async () => {
    await upsertPtiUserForUnit({} as never, { ...baseParams, stgUserId: undefined });

    expect(queries[0]).toContain('UPDATE pti');
    expect(queries.some((q) => q.includes('DELETE FROM tblPTIUserInfo'))).toBe(false);
  });

  it('UPDATE 에서 rowsAffected 가 0 이면 INSERT fallback 실행', async () => {
    // 기본 mock 은 rowsAffected [1] 을 반환하므로 UPDATE 에서 끝난다.
    // 여기서는 INSERT 경로 검증을 위해 UPDATE 만 0 을 돌려주도록 override.
    const mssql = jest.requireMock('mssql') as unknown as { Request: new () => { input: (a: string, b: unknown, c: unknown) => unknown; query: (text: string) => Promise<unknown> } };
    const origRequest = mssql.Request;
    let updateSeen = false;
    class FallbackRequest {
      private captured: Record<string, unknown> = {};
      input(name: string, _t: unknown, v: unknown) {
        this.captured[name] = v;
        return this;
      }
      async query(text: string) {
        queries.push(text);
        inputs.push({ ...this.captured });
        if (text.includes('UPDATE pti')) {
          updateSeen = true;
          return { rowsAffected: [0], recordset: [] };
        }
        return { rowsAffected: [1], recordset: [] };
      }
    }
    (mssql as unknown as { Request: unknown }).Request = FallbackRequest;

    try {
      await upsertPtiUserForUnit({} as never, baseParams);
      expect(updateSeen).toBe(true);
      const inserted = queries.find((q) => q.includes('INSERT INTO tblPTIUserInfo'));
      expect(inserted).toBeDefined();
    } finally {
      (mssql as unknown as { Request: unknown }).Request = origRequest;
    }
  });
});
