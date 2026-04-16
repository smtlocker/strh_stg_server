/**
 * 유닛 단위 마이그레이션 타겟팅 (공통).
 *
 * 003/004/005 스크립트에서 `--units 0002:0001:1005,0002:0001:1010` 형태의
 * CLI 인자를 받아 특정 유닛만 처리할 수 있게 하는 헬퍼.
 *
 * 포맷: `<officeCode>:<groupCode>:<showBoxNo>`
 *   - officeCode: STG `customFields.smartcube_siteCode` (4자리)
 *   - groupCode:  STG `customFields.smartcube_id` 의 앞부분 (4자리)
 *   - showBoxNo:  STG `smartcube_id` 의 뒷부분 (정수)
 *
 * 003/005 는 지정 유닛만 syncUnit 대상으로 통과.
 * 004 는 지정 유닛이 속한 사용자 group 전체를 처리 — resolveUnitTargets() 로
 * DB 에서 관련 userCode 집합을 역산한 뒤, 그 사용자의 전 group 에 reconcile 수행.
 */

/**
 * argv 에서 `--units VALUE`, `--units=VALUE` 형태를 찾아 반환. 없으면 null.
 */
function parseUnitsArg(argv) {
  const a = argv || process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const cur = a[i];
    if (cur === '--units') return a[i + 1] ?? null;
    if (cur.startsWith('--units=')) return cur.slice('--units='.length);
  }
  return null;
}

/**
 * `--units` CSV 문자열을 파싱해 배열로 반환. null/빈값 → null.
 * 엔트리별 검증: 3콤마 분할, officeCode 3-4자리, groupCode 4자리, showBoxNo 양의 정수.
 * 잘못된 포맷이면 throw.
 */
function parseUnitsEntries(unitsCsv) {
  if (unitsCsv == null) return null;
  const tokens = String(unitsCsv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  const entries = [];
  const seen = new Set();
  for (const t of tokens) {
    const parts = t.split(':');
    if (parts.length !== 3) {
      throw new Error(
        `--units 포맷 오류 "${t}": <officeCode>:<groupCode>:<showBoxNo> 필요`,
      );
    }
    const [officeRaw, groupRaw, boxRaw] = parts.map((p) => p.trim());
    if (!/^\d{3,4}$/.test(officeRaw)) {
      throw new Error(`--units "${t}": officeCode 는 3-4자리 숫자여야 함`);
    }
    if (!/^\d{4}$/.test(groupRaw)) {
      throw new Error(`--units "${t}": groupCode 는 4자리 숫자여야 함`);
    }
    const showBoxNo = parseInt(boxRaw, 10);
    if (!/^\d+$/.test(boxRaw) || isNaN(showBoxNo) || showBoxNo <= 0) {
      throw new Error(`--units "${t}": showBoxNo 는 양의 정수여야 함`);
    }
    const officeCode = officeRaw.padStart(4, '0');
    const key = `${officeCode}:${groupRaw}:${showBoxNo}`;
    if (seen.has(key)) continue; // dedupe
    seen.add(key);
    entries.push({ officeCode, groupCode: groupRaw, showBoxNo });
  }
  return entries;
}

/**
 * 루프에서 쓸 lookup 헬퍼.
 * has(officeCode, groupCode, showBoxNo) → boolean.
 * null 입력이면 항상 true 반환하는 passthrough 필터.
 */
function buildUnitFilter(entries) {
  if (entries == null || entries.length === 0) {
    return { has: () => true, enabled: false, entries: [] };
  }
  const set = new Set(
    entries.map((e) => `${e.officeCode}:${e.groupCode}:${e.showBoxNo}`),
  );
  return {
    has(officeCode, groupCode, showBoxNo) {
      return set.has(
        `${String(officeCode).padStart(4, '0')}:${groupCode}:${showBoxNo}`,
      );
    },
    enabled: true,
    entries,
  };
}

/**
 * entries 에서 officeCode 유니크 집합 추출. 없으면 null.
 * 003/005 가 STG site 를 이 집합으로만 fetch 하도록 해서 불필요한 API 호출 축소.
 */
function officesFromEntries(entries) {
  if (entries == null || entries.length === 0) return null;
  return [...new Set(entries.map((e) => e.officeCode))].join(',');
}

module.exports = {
  parseUnitsArg,
  parseUnitsEntries,
  buildUnitFilter,
  officesFromEntries,
};
