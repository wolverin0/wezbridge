/**
 * GitHub Webhook Handler for WezBridge.
 * Receives push, PR, and issue events and posts them to Telegram forum topics.
 *
 * Requires: WEZ_BRIDGE_PORT env var (shared with bot's HTTP server if any)
 * Optional: GITHUB_WEBHOOK_SECRET for signature verification
 */
const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

/**
 * Verify GitHub webhook signature (HMAC-SHA256).
 */
function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // Skip if no secret configured
  if (!signature) return false;
  const sig = signature.replace('sha256=', '');
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(payload, 'utf-8');
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Format a GitHub push event for Telegram.
 */
function formatPush(payload) {
  const repo = payload.repository?.full_name || 'unknown';
  const branch = (payload.ref || '').replace('refs/heads/', '');
  const commits = payload.commits || [];
  const pusher = payload.pusher?.name || 'unknown';

  const commitLines = commits.slice(0, 5).map(c => {
    const short = c.id.slice(0, 7);
    const msg = (c.message || '').split('\n')[0].slice(0, 60);
    return `  <code>${short}</code> ${escapeHtml(msg)}`;
  }).join('\n');

  const extra = commits.length > 5 ? `\n  <i>...and ${commits.length - 5} more</i>` : '';

  return [
    `<b>Push</b> to <code>${escapeHtml(repo)}</code>`,
    `Branch: <code>${escapeHtml(branch)}</code>`,
    `By: ${escapeHtml(pusher)}`,
    `${commits.length} commit${commits.length !== 1 ? 's' : ''}:`,
    commitLines + extra,
  ].join('\n');
}

/**
 * Format a GitHub pull_request event for Telegram.
 */
function formatPR(payload) {
  const pr = payload.pull_request || {};
  const repo = payload.repository?.full_name || 'unknown';
  const action = payload.action || 'updated';
  const title = pr.title || 'Untitled';
  const number = pr.number || '?';
  const user = pr.user?.login || 'unknown';
  const url = pr.html_url || '';

  const icons = {
    opened: '\ud83d\udfe2',
    closed: '\ud83d\udd34',
    merged: '\ud83d\udfe3',
    reopened: '\ud83d\udfe1',
  };
  const icon = icons[action] || '\ud83d\udccc';

  return [
    `${icon} <b>PR #${number} ${escapeHtml(action)}</b>`,
    `<b>${escapeHtml(title)}</b>`,
    `Repo: <code>${escapeHtml(repo)}</code>`,
    `By: ${escapeHtml(user)}`,
    url ? `<a href="${url}">View PR</a>` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Format a GitHub issue event for Telegram.
 */
function formatIssue(payload) {
  const issue = payload.issue || {};
  const repo = payload.repository?.full_name || 'unknown';
  const action = payload.action || 'updated';
  const title = issue.title || 'Untitled';
  const number = issue.number || '?';
  const user = issue.user?.login || 'unknown';
  const url = issue.html_url || '';

  return [
    `\ud83d\udcdd <b>Issue #${number} ${escapeHtml(action)}</b>`,
    `<b>${escapeHtml(title)}</b>`,
    `Repo: <code>${escapeHtml(repo)}</code>`,
    `By: ${escapeHtml(user)}`,
    url ? `<a href="${url}">View Issue</a>` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Format a workflow_run event (GitHub Actions).
 */
function formatWorkflowRun(payload) {
  const run = payload.workflow_run || {};
  const repo = payload.repository?.full_name || 'unknown';
  const name = run.name || 'Unknown workflow';
  const conclusion = run.conclusion || run.status || 'unknown';
  const branch = run.head_branch || 'unknown';
  const url = run.html_url || '';

  const icons = {
    success: '\u2705',
    failure: '\u274c',
    cancelled: '\u23f8\ufe0f',
    in_progress: '\u23f3',
  };
  const icon = icons[conclusion] || '\ud83d\udccc';

  return [
    `${icon} <b>Workflow: ${escapeHtml(name)}</b>`,
    `Result: <code>${conclusion}</code>`,
    `Repo: <code>${escapeHtml(repo)}</code>`,
    `Branch: <code>${escapeHtml(branch)}</code>`,
    url ? `<a href="${url}">View Run</a>` : '',
  ].filter(Boolean).join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Parse a webhook payload and return formatted HTML + event type.
 */
function parseWebhook(event, payload) {
  switch (event) {
    case 'push':
      return { html: formatPush(payload), type: 'push' };
    case 'pull_request':
      return { html: formatPR(payload), type: 'pr' };
    case 'issues':
      return { html: formatIssue(payload), type: 'issue' };
    case 'workflow_run':
      if (payload.action === 'completed') {
        return { html: formatWorkflowRun(payload), type: 'workflow' };
      }
      return null; // Skip in_progress events
    default:
      return null; // Unsupported event
  }
}

/**
 * Create Express middleware for GitHub webhooks.
 * @param {Function} onEvent - callback(repoFullName, html, eventType)
 */
function createWebhookMiddleware(onEvent) {
  return (req, res) => {
    const event = req.headers['x-github-event'];
    if (!event) {
      return res.status(400).json({ error: 'Missing X-GitHub-Event header' });
    }

    // Verify signature if secret is configured
    const rawBody = req.body ? JSON.stringify(req.body) : '';
    if (WEBHOOK_SECRET && !verifySignature(rawBody, req.headers['x-hub-signature-256'])) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body;
    const result = parseWebhook(event, payload);

    if (!result) {
      return res.status(200).json({ status: 'ignored', event });
    }

    const repoFullName = payload.repository?.full_name || '';

    // Call the event handler (telegram-bot.cjs will map repo -> topic)
    try {
      onEvent(repoFullName, result.html, result.type);
      res.status(200).json({ status: 'ok', event: result.type });
    } catch (err) {
      console.error('[github-webhook] Handler error:', err.message);
      res.status(500).json({ error: 'Handler failed' });
    }
  };
}

module.exports = {
  verifySignature,
  parseWebhook,
  formatPush,
  formatPR,
  formatIssue,
  formatWorkflowRun,
  createWebhookMiddleware,
  escapeHtml,
};
