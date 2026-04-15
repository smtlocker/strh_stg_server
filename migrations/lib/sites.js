/**
 * STG site 매핑 (공통).
 *
 * 003/004/006 가 공유. 새 지점 추가 시 여기만 수정.
 *
 * 지점별 선택 실행은 각 스크립트의 `--offices` CLI 인자로 지정한다.
 * 각 스크립트는 `parseOfficesArg()` + `resolveSites(cli)` 를 호출해 대상
 * site 목록을 얻는다. 전역 env/flag 를 추가하지 않고 명령행에서만 제어한다.
 *
 *   node migrations/migrate-all.js --offices 001          # 송파만
 *   node migrations/migrate-all.js --offices 001,003      # 송파 + 선릉
 *   (미지정)                                              # 전체 3지점
 */

const ALL_SITES = [
  { name: '송파점', officeCode: '001', siteId: '698ed8d861c38505daecc6b4' },
  { name: '마곡점', officeCode: '002', siteId: '69c217cd53c43d6dfe7266b0' },
  { name: '선릉점', officeCode: '003', siteId: '698eda4461c38505daee95eb' },
];

/**
 * argv 에서 `--offices VALUE`, `--offices=VALUE`, `-o VALUE` 형태를 찾아 반환.
 * 없으면 null.
 */
function parseOfficesArg(argv) {
  const a = argv || process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const cur = a[i];
    if (cur === '--offices' || cur === '-o') return a[i + 1] ?? null;
    if (cur.startsWith('--offices=')) return cur.slice('--offices='.length);
  }
  return null;
}

/**
 * CLI 인자 값을 사이트 목록으로 해석. null/빈값이면 전체 반환.
 * 알 수 없는 officeCode 가 포함되면 throw.
 */
function resolveSites(officesCsv) {
  if (officesCsv == null) return ALL_SITES;
  const tokens = String(officesCsv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return ALL_SITES;

  const known = new Set(ALL_SITES.map((s) => s.officeCode));
  const unknown = tokens.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `--offices 에 알 수 없는 officeCode: ${unknown.join(', ')}. 허용: ${ALL_SITES.map((s) => s.officeCode).join(', ')}`,
    );
  }
  const selected = ALL_SITES.filter((s) => tokens.includes(s.officeCode));
  if (selected.length === 0) {
    throw new Error(`--offices 가 비어있거나 매칭되는 site 가 없습니다: "${officesCsv}"`);
  }
  return selected;
}

module.exports = {
  // 기본 export 는 전체 — CLI 를 모르는 legacy 호출자용.
  // CLI 반영이 필요한 스크립트는 resolveSites(parseOfficesArg()) 로 얻어쓴다.
  SITES: ALL_SITES,
  ALL_SITES,
  parseOfficesArg,
  resolveSites,
};
