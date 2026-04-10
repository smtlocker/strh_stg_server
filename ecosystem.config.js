module.exports = {
  apps: [
    {
      name: 'smartcube-sync',
      script: 'dist/src/main.js',
      watch: ['dist'],
      ignore_watch: ['node_modules', 'src', 'test', 'coverage'],
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
