export interface AppConfig {
  port: number;
  database: {
    host?: string;
    port: number;
    user?: string;
    password?: string;
    name?: string;
    tdsVersion?: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    poolMax: number;
    poolMin: number;
    poolIdleTimeout: number;
  };
  storeganise: {
    baseUrl?: string;
    apiKey?: string;
    webhookSecret?: string;
  };
  monitoringAuth: {
    cookieName: string;
    sessionTtlMs: number;
    cookieSecure: string;
  };
  alerts: {
    from: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
    };
  };
}

const configuration = (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '4100', 10),
  database: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT ?? '1433', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
    tdsVersion: process.env.DB_TDS_VERSION || undefined,
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '10', 10),
    poolMin: parseInt(process.env.DB_POOL_MIN ?? '1', 10),
    poolIdleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT ?? '30000', 10),
  },
  storeganise: {
    baseUrl: process.env.SG_BASE_URL,
    apiKey: process.env.SG_API_KEY,
    webhookSecret: process.env.SG_WEBHOOK_SECRET,
  },
  monitoringAuth: {
    cookieName:
      process.env.MONITORING_SESSION_COOKIE_NAME ??
      'smartcube_monitoring_session',
    sessionTtlMs: parseInt(
      process.env.MONITORING_SESSION_TTL_MS ?? `${8 * 60 * 60 * 1000}`,
      10,
    ),
    cookieSecure: process.env.MONITORING_SESSION_COOKIE_SECURE ?? 'auto',
  },
  alerts: {
    from:
      process.env.SMTP_FROM ??
      'SmartCube Alerts <alerts@smartlocker.co.kr>',
    smtp: {
      host: process.env.SMTP_HOST ?? '',
      port: parseInt(process.env.SMTP_PORT ?? '465', 10),
      secure: parseInt(process.env.SMTP_PORT ?? '465', 10) === 465,
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
    },
  },
});

export default configuration;
