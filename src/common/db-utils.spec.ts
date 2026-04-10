import { parseAreaCodeParts } from './db-utils';

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
