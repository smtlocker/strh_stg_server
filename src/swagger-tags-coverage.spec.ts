import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { AppModule } from './app.module';
import { stripFallbackTags } from './monitoring/swagger-tag-utils';

describe('Swagger document tag coverage', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = stripFallbackTags(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('SmartCube Sync Server')
          .setVersion('test')
          .build(),
      ),
      ['Monitoring'],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('every operation has a non-empty summary', () => {
    const missing: string[] = [];
    for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (op && typeof op === 'object' && 'summary' in op) {
          const summary = (op as { summary?: string }).summary;
          if (!summary || summary.trim() === '') {
            missing.push(`${method.toUpperCase()} ${pathKey}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('matches expected tag coverage (monitoring/dashboard|sync|grid|debug, auth, access-code, webhook)', () => {
    const tagCounts: Record<string, number> = {};
    for (const pathItem of Object.values(document.paths ?? {})) {
      for (const op of Object.values(pathItem)) {
        if (op && typeof op === 'object' && 'tags' in op) {
          const tags = (op as { tags?: string[] }).tags ?? [];
          for (const tag of tags) {
            tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
          }
        }
      }
    }

    // 모든 그룹은 정확한 카운트로 고정 — endpoint 가 의도와 다른 그룹으로 흘러가는
    // 회귀를 즉시 잡는다. 새 endpoint 추가 시 이 spec 을 함께 갱신해야 함.
    expect(tagCounts['monitoring/dashboard']).toBe(7);
    expect(tagCounts['monitoring/sync']).toBe(6);
    expect(tagCounts['monitoring/grid']).toBe(4);
    expect(tagCounts['monitoring/debug']).toBe(5);
    expect(tagCounts['auth']).toBe(3);
    expect(tagCounts['access-code']).toBe(1);
    expect(tagCounts['webhook']).toBe(1);
    // fallback tag regression guard — controller class name 자동 태깅 차단 유지 검증
    expect(tagCounts['Monitoring']).toBeUndefined();
  });
});
