const fs = require('fs');
const path = require('path');

// Windows(nest build)는 dist/main.js, Mac/Linux는 dist/src/main.js
const primary = path.join(__dirname, 'dist', 'main.js');
const fallback = path.join(__dirname, 'dist', 'src', 'main.js');
const script = fs.existsSync(primary) ? primary : fallback;

module.exports = {
  apps: [
    {
      name: 'smartcube-sync',
      script,
      watch: ['dist'],
      ignore_watch: ['node_modules', 'src', 'test', 'coverage'],
      // 인증서 갱신 반영 + 메모리 leak 방어용 주기적 재시작. 로컬 TZ 기준 매일 새벽 3시.
      // moveIn.activate(00:00) / moveOut.block(23:59:59) 스케줄러와 안 겹치는 안전 구간.
      // 재시작 시 main.ts 의 buildHttpsOptions 가 SSL_KEY+SSL_CERT 를 다시 읽어
      // 갱신된 인증서로 TLS 컨텍스트를 재구성한다.
      cron_restart: '0 3 * * *',
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
