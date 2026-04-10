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
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
