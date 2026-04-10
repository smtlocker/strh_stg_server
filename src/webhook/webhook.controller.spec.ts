import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

describe('WebhookController', () => {
  it('stores logging context on request without mutating request body', async () => {
    const webhookService = {
      handle: jest.fn().mockResolvedValue({
        skipLog: true,
        syncMeta: { stgUserId: 'user-1' },
      }),
    } as unknown as WebhookService;
    const controller = new WebhookController(webhookService);

    const payload = {
      id: 'evt-1',
      type: 'unit.updated',
      data: { changedKeys: ['customFields.other'] },
    };
    const req = {
      body: payload,
    } as any;

    const result = await controller.handleWebhook(payload as any, req);

    expect(result).toEqual({ status: 'ok' });
    expect(req.body).toEqual(payload);
    expect(req.omxWebhookLog).toEqual({
      skipLog: true,
      syncMeta: { stgUserId: 'user-1' },
    });
  });
});
