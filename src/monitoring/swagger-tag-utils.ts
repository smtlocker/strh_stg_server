import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * @nestjs/swagger 는 class-level @ApiTags 가 없으면 controller 클래스명을
 * PascalCase fallback 태그로 자동 부착한다. monitoring controller 는 endpoint
 * 별로 4개 그룹(monitoring/dashboard|sync|grid|debug)으로 세분화돼있어
 * fallback 'Monitoring' 태그가 5번째 더미 그룹으로 노출되는 부작용이 있다.
 * createDocument 직후 이 헬퍼로 fallback 태그를 일괄 제거한다.
 */
export function stripFallbackTags(
  document: OpenAPIObject,
  fallbackTags: string[],
): OpenAPIObject {
  // NOTE: in-place mutation. 호출처 편의상 동일 reference 를 return 하지만
  // pure 함수가 아님 — 외부 캐싱/공유 document 와 함께 쓰지 말 것.
  const fallback = new Set(fallbackTags);
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const op of Object.values(pathItem)) {
      if (op && typeof op === 'object' && Array.isArray((op as { tags?: unknown }).tags)) {
        const operation = op as { tags?: string[] };
        operation.tags = operation.tags!.filter((t) => !fallback.has(t));
      }
    }
  }
  if (Array.isArray(document.tags)) {
    document.tags = document.tags.filter((t) => !fallback.has(t.name));
  }
  return document;
}
