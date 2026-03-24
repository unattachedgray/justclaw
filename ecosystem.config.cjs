const { readFileSync } = require('fs');
const { join } = require('path');

// Load .env file for secrets.
function loadEnv() {
  const env = {};
  try {
    const lines = readFileSync(join(__dirname, '.env'), 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  } catch { /* no .env file */ }
  return env;
}

const dotenv = loadEnv();
const ROOT = process.env.JUSTCLAW_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: 'justclaw-dashboard',
      script: 'dist/dashboard/app.js',
      cwd: ROOT,
      kill_timeout: 5000,        // 5s graceful shutdown before SIGKILL
      max_restarts: 10,          // Crash-loop protection
      min_uptime: 5000,          // Must survive 5s to count as "started"
      max_memory_restart: '200M', // Restart if memory leak
      env: {
        JUSTCLAW_ROOT: ROOT,
        JUSTCLAW_CONFIG: join(ROOT, 'config/charlie.toml'),
        DASHBOARD_PASSWORD: dotenv.DASHBOARD_PASSWORD || '88888888',
        PATH: process.env.PATH,
      },
    },
    {
      name: 'justclaw-discord',
      script: 'dist/discord/bot.js',
      cwd: ROOT,
      kill_timeout: 10000,       // 10s — needs time to kill claude -p children
      max_restarts: 10,
      min_uptime: 5000,
      max_memory_restart: '300M',
      wait_ready: true,           // Bot sends process.send('ready') after Discord connects
      listen_timeout: 30000,     // 30s to connect or PM2 considers it failed
      env: {
        JUSTCLAW_ROOT: ROOT,
        JUSTCLAW_CONFIG: join(ROOT, 'config/charlie.toml'),
        DISCORD_BOT_TOKEN: dotenv.DISCORD_BOT_TOKEN || '',
        DISCORD_CHANNEL_IDS: dotenv.DISCORD_CHANNEL_IDS || '',
        DISCORD_HEARTBEAT_CHANNEL_ID: dotenv.DISCORD_HEARTBEAT_CHANNEL_ID || '',
        HEARTBEAT_INTERVAL_MS: dotenv.HEARTBEAT_INTERVAL_MS || '300000',
        JUSTCLAW_DEBUG: dotenv.JUSTCLAW_DEBUG || process.env.JUSTCLAW_DEBUG || '',
        PATH: process.env.PATH,
      },
    },
  ],
};
