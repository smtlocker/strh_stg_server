import type { Request } from 'express';
import { MonitoringOriginValidatorService } from './monitoring-origin-validator.service';

describe('MonitoringOriginValidatorService', () => {
  const service = new MonitoringOriginValidatorService();

  it('accepts same-origin requests via Origin', () => {
    expect(
      service.isSameOrigin({
        headers: {
          host: 'monitoring.test',
          origin: 'https://monitoring.test',
        },
      } as Request),
    ).toBe(true);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(
      service.isSameOrigin({
        headers: {
          host: 'monitoring.test',
          referer: 'https://monitoring.test/monitoring',
        },
      } as Request),
    ).toBe(true);
  });

  it('rejects foreign or header-less requests', () => {
    expect(
      service.isSameOrigin({
        headers: {
          host: 'monitoring.test',
          origin: 'https://evil.test',
        },
      } as Request),
    ).toBe(false);

    expect(
      service.isSameOrigin({
        headers: {
          host: 'monitoring.test',
        },
      } as Request),
    ).toBe(false);
  });
});
