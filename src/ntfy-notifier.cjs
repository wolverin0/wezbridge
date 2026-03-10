/**
 * ntfy.sh Backup Notification Channel for WezBridge.
 * Sends push notifications via ntfy.sh as a fallback/redundant channel.
 *
 * Env vars:
 *   NTFY_TOPIC    — ntfy.sh topic name (e.g. 'wezbridge-alerts')
 *   NTFY_SERVER   — optional, defaults to 'https://ntfy.sh'
 *   NTFY_TOKEN    — optional, for authenticated topics
 *   NTFY_ENABLED  — optional, 'true' to enable (default: disabled)
 */
const https = require('https');
const http = require('http');

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const NTFY_ENABLED = process.env.NTFY_ENABLED === 'true';

/**
 * Check if ntfy notifications are configured and enabled.
 */
function isAvailable() {
  return NTFY_ENABLED && !!NTFY_TOPIC;
}

/**
 * Send a notification via ntfy.sh.
 * @param {string} title - Notification title
 * @param {string} message - Notification body (plain text)
 * @param {object} opts - Optional: priority (1-5), tags (array of emoji tags), click (URL)
 */
function notify(title, message, opts = {}) {
  if (!isAvailable()) return Promise.resolve();

  const url = new URL(`/${NTFY_TOPIC}`, NTFY_SERVER);
  const isHttps = url.protocol === 'https:';
  const proto = isHttps ? https : http;

  const headers = {
    'Content-Type': 'text/plain',
    'Title': title,
  };

  if (opts.priority) headers['Priority'] = String(opts.priority);
  if (opts.tags && opts.tags.length) headers['Tags'] = opts.tags.join(',');
  if (opts.click) headers['Click'] = opts.click;
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;

  return new Promise((resolve, reject) => {
    const req = proto.request(url, {
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', (err) => {
      console.error('[ntfy] Send failed:', err.message);
      resolve(); // Don't reject — ntfy is best-effort
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve();
    });
    req.write(message);
    req.end();
  });
}

/**
 * Pre-built notification types for WezBridge events.
 */
function notifyCompletion(sessionName, preview) {
  return notify(
    `${sessionName} — Complete`,
    preview.slice(0, 500),
    { priority: 3, tags: ['white_check_mark', 'robot'] }
  );
}

function notifyError(sessionName, error) {
  return notify(
    `${sessionName} — Error`,
    error.slice(0, 500),
    { priority: 4, tags: ['x', 'warning'] }
  );
}

function notifyPermission(sessionName, detail) {
  return notify(
    `${sessionName} — Permission Required`,
    detail.slice(0, 300),
    { priority: 5, tags: ['question', 'lock'] }
  );
}

function notifyStatus(summary) {
  return notify(
    'WezBridge Status',
    summary,
    { priority: 2, tags: ['bar_chart'] }
  );
}

module.exports = {
  isAvailable,
  notify,
  notifyCompletion,
  notifyError,
  notifyPermission,
  notifyStatus,
};
