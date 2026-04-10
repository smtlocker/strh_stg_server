import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: sql.ConnectionPool | null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const config: sql.config = {
      server: this.configService.getOrThrow<string>('database.host'),
      port: this.configService.getOrThrow<number>('database.port'),
      user: this.configService.getOrThrow<string>('database.user'),
      password: this.configService.getOrThrow<string>('database.password'),
      database: this.configService.getOrThrow<string>('database.name'),
      options: {
        encrypt: this.configService.getOrThrow<boolean>('database.encrypt'),
        trustServerCertificate: this.configService.getOrThrow<boolean>(
          'database.trustServerCertificate',
        ),
        // 호호락 MSSQL 서버는 KST wall clock을 GETDATE()로 반환한다 (Windows OS
        // 시계가 KST이지만 SYSDATETIMEOFFSET은 +0으로 표시되는 구성).
        // mssql 기본값 useUTC=true는 드라이버가 JS Date의 UTC 컴포넌트로
        // write/read를 처리하게 만들어 9시간 오프셋을 유발한다.
        // 이를 useUTC=false로 두면 드라이버가 process local(KST) 컴포넌트를
        // 기반으로 동작해 handler가 만드는 "오늘 23:59:59" 같은 wall clock
        // 값이 GETDATE() 비교와 정확히 일치한다.
        useUTC: false,
        ...(this.configService.get<string>('database.tdsVersion')
          ? {
              tdsVersion: this.configService.get<string>('database.tdsVersion'),
            }
          : {}),
      },
      pool: {
        max: this.configService.getOrThrow<number>('database.poolMax'),
        min: this.configService.getOrThrow<number>('database.poolMin'),
        idleTimeoutMillis: this.configService.getOrThrow<number>(
          'database.poolIdleTimeout',
        ),
      },
    };

    this.pool = new sql.ConnectionPool(config);
    try {
      await this.pool.connect();
      this.logger.log('MSSQL connection pool established');
      await this.ensureSyncLogColumns();
    } catch (err) {
      this.logger.error(`MSSQL connection failed: ${(err as Error).message}`);
      this.logger.warn(
        'Server running without DB connection. DB-dependent features will fail.',
      );
      this.pool = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.logger.log('MSSQL connection pool closed');
    }
  }

  /** tblSyncLog 운영 메타 컬럼이 없으면 추가 */
  private async ensureSyncLogColumns(): Promise<void> {
    if (!this.pool) return;
    const columns = [
      { name: 'userName', type: 'NVARCHAR(100)' },
      { name: 'stgUserId', type: 'NVARCHAR(100)' },
      { name: 'stgUnitId', type: 'NVARCHAR(100)' },
      { name: 'correlationKey', type: 'NVARCHAR(200)' },
      { name: 'replayedFromLogId', type: 'BIGINT' },
      { name: 'alertSentAt', type: 'DATETIME2' },
      { name: 'alertStatus', type: 'NVARCHAR(30)' },
    ];
    for (const col of columns) {
      try {
        await this.pool.request().query(`
          IF NOT EXISTS (
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'tblSyncLog' AND COLUMN_NAME = '${col.name}'
          )
          ALTER TABLE tblSyncLog ADD ${col.name} ${col.type} NULL
        `);
      } catch (err) {
        this.logger.warn(
          `Failed to ensure column ${col.name}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      'tblSyncLog columns verified (userName, stgUserId, stgUnitId, correlationKey, replayedFromLogId, alertSentAt, alertStatus)',
    );
  }

  async query<T = unknown>(
    sqlText: string,
    params?: Record<string, unknown>,
  ): Promise<sql.IResult<T>> {
    if (!this.pool) {
      throw new Error('Database connection not available');
    }
    const request = this.pool.request();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        request.input(key, value);
      }
    }
    return request.query<T>(sqlText);
  }

  /** 직접 sql.Request를 생성해야 할 때 사용 (명시적 타입 바인딩 등) */
  getPool(): sql.ConnectionPool {
    if (!this.pool) {
      throw new Error('Database connection not available');
    }
    return this.pool;
  }

  async beginTransaction(): Promise<sql.Transaction> {
    if (!this.pool) {
      throw new Error('Database connection not available');
    }
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    return transaction;
  }
}
