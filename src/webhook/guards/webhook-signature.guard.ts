import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class WebhookSignatureGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private secret: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const secret = this.configService.get<string>('storeganise.webhookSecret');
    if (!secret) {
      throw new Error(
        'SG_WEBHOOK_SECRET is not configured. Server cannot start without webhook authentication.',
      );
    }
    this.secret = secret;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signature = request.headers['sg-signature'] as string;

    this.logger.debug(
      `Received headers: ${JSON.stringify(Object.keys(request.headers))}`,
    );

    if (!signature) {
      this.logger.warn('Missing sg-signature header');
      throw new UnauthorizedException('Missing webhook signature');
    }

    const rawBody: Buffer | undefined = request.rawBody;

    if (!rawBody) {
      this.logger.warn('Raw body not available for signature verification');
      throw new UnauthorizedException('Cannot verify signature');
    }

    const expectedSignature = createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('base64');

    this.logger.debug(`Raw body length: ${rawBody.length} bytes`);

    const isValid =
      signature.length === expectedSignature.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

    if (!isValid) {
      this.logger.warn('Signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log('Signature verified successfully');
    return true;
  }
}
