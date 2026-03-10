/**
 * PM2 Ecosystem Configuration for WezBridge.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart wezbridge-bot
 *   pm2 logs wezbridge-bot
 *   pm2 stop wezbridge-bot
 */
module.exports = {
  apps: [
    {
      name: 'wezbridge-bot',
      script: 'src/wez-bridge/telegram-bot.cjs',
      cwd: __dirname,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000, // exponential backoff on rapid crashes

      // Watching (optional — disable for production)
      watch: false,
      ignore_watch: ['node_modules', '.git', 'docs', '*.log'],

      // Logging
      error_file: 'logs/wezbridge-error.log',
      out_file: 'logs/wezbridge-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      max_size: '10M',    // rotate logs at 10MB
      retain: 5,          // keep 5 rotated log files

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Pass through all TELEGRAM_*, OPENAI_*, CLAWTROL_*, WEZBRIDGE_* env vars
      // PM2 inherits the parent process environment by default

      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 8000,

      // Memory limit — restart if bot exceeds 500MB
      max_memory_restart: '500M',
    },
  ],
};
