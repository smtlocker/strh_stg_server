/**
 * STG site 매핑 (공통).
 *
 * 이전에는 siteId/officeCode 를 이 파일에 하드코딩했으나,
 * 이제 STG `/v1/admin/sites?include=customFields` 로 런타임에 조회한다.
 *   - `site.customFields.smartcube_siteCode` (4자리 문자열) → `officeCode`
 *   - `site.id` → `siteId`
 *   - `site.title.ko || title.en || code` → `name`
 *
 * customFields.smartcube_siteCode 가 설정된 site 만 반환하므로, STG 콘솔에서
 * 각 지점에 이 커스텀 필드를 세팅해야 마이그레이션 대상이 된다.
 *
 * 지점별 선택 실행:
 *   node migrations/migrate-all.js --offices 0002          # 마곡만
 *   node migrations/migrate-all.js --offices 0001,0003     # 송파 + 선릉
 *   (미지정)                                               # STG 가 반환하는 모든 지점
 *
 * DB `tblBoxMaster.areaCode` 는 `strh<3자리officeCode><4자리groupCode>` 레거시
 * 포맷을 유지하므로, 4자리 officeCode 를 DB 쿼리에 쓸 때는 마지막 3자리만
 * 추출(`code.slice(-3)`)하거나 padStart 로 변환한다.
 */

/**
 * argv 에서 `--offices VALUE`, `--offices=VALUE`, `-o VALUE` 형태를 찾아 반환.
 * 없으면 null. (sync 유지 — 인자 파싱만 담당)
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
 * STG 의 모든 site 를 조회해서 customFields.smartcube_siteCode 가 있는 것만 매핑.
 * write 는 하지 않음. 실패 시 throw.
 */
async function fetchAllSites(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) {
    throw new Error(
      'SG_BASE_URL / SG_API_KEY env 가 필요합니다 (.env 확인). STG site 조회 불가.',
    );
  }
  const res = await fetch(
    `${baseUrl}/v1/admin/sites?include=customFields&limit=100`,
    { headers: { Authorization: `ApiKey ${apiKey}` } },
  );
  if (!res.ok) {
    throw new Error(`STG /v1/admin/sites GET 실패: HTTP ${res.status}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error('STG /v1/admin/sites 응답이 배열이 아닙니다.');
  }
  return raw
    .filter((s) => s && s.customFields && s.customFields.smartcube_siteCode)
    .map((s) => ({
      name: (s.title && (s.title.ko || s.title.en)) || s.code || s.id,
      officeCode: String(s.customFields.smartcube_siteCode),
      siteId: s.id,
    }));
}

/**
 * CLI 인자 값(officesCsv)을 사이트 목록으로 해석.
 * - null/빈값 → STG 가 반환하는 전체 site (customFields.smartcube_siteCode 있는 것)
 * - "0002" / "0001,0003" → 해당 officeCode 만
 * 알 수 없는 officeCode 나 빈 결과는 throw.
 *
 * options.baseUrl / options.apiKey 로 STG 엔드포인트 override 가능 (테스트용).
 */
async function resolveSites(officesCsv, options = {}) {
  const baseUrl = options.baseUrl ?? process.env.SG_BASE_URL;
  const apiKey = options.apiKey ?? process.env.SG_API_KEY;
  const all = await fetchAllSites(baseUrl, apiKey);
  if (all.length === 0) {
    throw new Error(
      'STG 에서 `customFields.smartcube_siteCode` 가 설정된 site 를 찾지 못했습니다. ' +
        'STG 콘솔에서 각 지점에 smartcube_siteCode(4자리) 를 먼저 세팅하세요.',
    );
  }

  if (officesCsv == null) return all;
  const tokens = String(officesCsv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return all;

  const known = new Set(all.map((s) => s.officeCode));
  const unknown = tokens.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `--offices 에 알 수 없는 officeCode: ${unknown.join(', ')}. 허용: ${[...known].join(', ')}`,
    );
  }
  const selected = all.filter((s) => tokens.includes(s.officeCode));
  if (selected.length === 0) {
    throw new Error(
      `--offices 가 매칭되는 site 가 없습니다: "${officesCsv}"`,
    );
  }
  return selected;
}

/**
 * DB areaCode/OfficeCode 컬럼은 레거시 3자리 포맷이므로, 4자리 officeCode 를
 * DB 쿼리에 쓸 때 마지막 3자리만 사용한다. (`"0002"` → `"002"`)
 */
function toDbOfficeCode(officeCode4) {
  return String(officeCode4).slice(-3);
}

module.exports = {
  parseOfficesArg,
  resolveSites,
  fetchAllSites,
  toDbOfficeCode,
};
