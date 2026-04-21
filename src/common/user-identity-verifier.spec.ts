import {
  looksLikePhoneCode,
  verifyUserIdentity,
  IdentityStgPort,
} from './user-identity-verifier';

describe('user-identity-verifier', () => {
  describe('looksLikePhoneCode', () => {
    it.each([
      ['01012345678', true],
      ['0104089876', true], // 레거시 truncate 된 10자리 mobile
      ['01099998888', true],
      ['69df036a64c84c195ba948a6', false], // STG uid (24자 hex)
      ['stg-user-1', false],
      ['', false],
      [null, false],
      [undefined, false],
    ])('%s → %s', (input, expected) => {
      expect(looksLikePhoneCode(input as string)).toBe(expected);
    });
  });

  describe('fast-path (userCode)', () => {
    it('양쪽 STG uid 가 일치하면 STG 조회 없이 통과', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest.fn(),
      };
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-1', userPhone: '01012345678' },
        { userCode: 'stg-user-1', userPhone: '01012345678' },
        { rentalId: 'rental-1', sgApi },
      );

      expect(result.matches).toBe(true);
      expect(result.source).toBe('userCode');
      expect(sgApi.getUnitRental).not.toHaveBeenCalled();
    });

    it('양쪽 STG uid 가 달라도 STG 재조회로 확증 시도', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest.fn().mockResolvedValue({ ownerId: 'stg-user-A' }),
      };
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-A', userPhone: '01012345678' },
        { userCode: 'stg-user-B', userPhone: '01099998888' },
        { rentalId: 'rental-1', sgApi },
      );

      // STG 가 expected 와 동일한 owner 라고 답하면 통과 (DB 가 stale 한 케이스)
      expect(result.matches).toBe(true);
      expect(result.source).toBe('stg-rental');
      expect(sgApi.getUnitRental).toHaveBeenCalledWith('rental-1');
    });
  });

  describe('STG rental re-fetch', () => {
    it('DB userCode 가 phone 으로 덮어써진 상태에서 STG 가 job.userCode 와 같은 owner 확인 → match', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest
          .fn()
          .mockResolvedValue({ ownerId: '69df036a64c84c195ba948a6' }),
      };
      const result = await verifyUserIdentity(
        {
          userCode: '69df036a64c84c195ba948a6',
          userPhone: '01040898769',
        },
        {
          userCode: '0104089876', // 레거시 PTI 가 phone 으로 덮어씀
          userPhone: '0104089876',
        },
        { rentalId: 'rental-abc', sgApi },
      );

      expect(result.matches).toBe(true);
      expect(result.source).toBe('stg-rental');
      expect(result.detail).toContain('69df036a64c84c195ba948a6');
    });

    it('STG owner 가 job.userCode 와 다르면 mismatch', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest.fn().mockResolvedValue({ ownerId: 'stg-user-NEW' }),
      };
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-OLD', userPhone: '01012345678' },
        { userCode: '0101234', userPhone: '0101234' },
        { rentalId: 'rental-1', sgApi },
      );

      expect(result.matches).toBe(false);
      expect(result.source).toBe('stg-rental');
    });

    it('STG rental 에 ownerId 가 없으면 mismatch (보수적)', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest
          .fn()
          .mockResolvedValue({ ownerId: undefined, state: 'completed' }),
      };
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-1', userPhone: '01012345678' },
        { userCode: '0101234', userPhone: '0101234' },
        { rentalId: 'rental-1', sgApi },
      );

      expect(result.matches).toBe(false);
      expect(result.source).toBe('stg-rental');
    });

    it('STG 호출이 예외를 던지면 phone-fallback 으로 진입', async () => {
      const sgApi: IdentityStgPort = {
        getUnitRental: jest.fn().mockRejectedValue(new Error('network down')),
      };
      const logger = { warn: jest.fn() };
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-1', userPhone: '01012345678' },
        { userCode: '0101234567', userPhone: '01012345678' },
        { rentalId: 'rental-1', sgApi, logger },
      );

      expect(result.matches).toBe(true);
      expect(result.source).toBe('phone');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('phone-fallback', () => {
    it('rentalId 없고 userCode 비어있을 때 phone 일치 → match', async () => {
      const result = await verifyUserIdentity(
        { userCode: '', userPhone: '01012345678' },
        { userCode: '', userPhone: '01012345678' },
      );
      expect(result.matches).toBe(true);
      expect(result.source).toBe('phone');
    });

    it('한쪽만 STG uid 이고 rentalId 없으면 phone 비교', async () => {
      const result = await verifyUserIdentity(
        { userCode: 'stg-user-1', userPhone: '01012345678' },
        { userCode: '', userPhone: '01012345678' },
      );
      expect(result.matches).toBe(true);
      expect(result.source).toBe('phone');
    });

    it('phone 포맷이 달라도 normalizePhone 후 일치하면 match', async () => {
      const result = await verifyUserIdentity(
        { userCode: '', userPhone: '+82 10 1234 5678' },
        { userCode: '', userPhone: '01012345678' },
      );
      expect(result.matches).toBe(true);
    });

    it('phone 다르면 mismatch', async () => {
      const result = await verifyUserIdentity(
        { userCode: '', userPhone: '01012345678' },
        { userCode: '', userPhone: '01099998888' },
      );
      expect(result.matches).toBe(false);
      expect(result.source).toBe('phone');
    });
  });

  describe('unknown', () => {
    it('어느 쪽에도 comparable identity 가 없으면 mismatch', async () => {
      const result = await verifyUserIdentity(
        { userCode: '', userPhone: '' },
        { userCode: '', userPhone: '' },
      );
      expect(result.matches).toBe(false);
      expect(result.source).toBe('unknown');
    });
  });
});
