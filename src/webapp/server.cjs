/**
 * WezBridge Mini App Server.
 * Provides REST API + static dashboard for Telegram Mini App.
 */
const express = require('express');
const path = require('path');

/**
 * Create the Mini App Express app.
 * @param {object} deps - Dependencies from telegram-bot.cjs
 * @param {object} deps.sm - Session manager
 * @param {object} deps.wez - WezTerm wrapper
 * @param {Map} deps.sessionToTopic - Session->topic mapping
 * @param {Map} deps.liveStreams - Active live streams
 * @param {number} deps.startTime - Bot start timestamp
 */
function createApp({ sm, wez, sessionToTopic, liveStreams, startTime }) {
  const app = express();
  app.use(express.json());

  // Serve static dashboard
  app.use(express.static(path.join(__dirname)));

  // API: all sessions
  app.get('/api/sessions', (req, res) => {
    try {
      const sessions = sm.listSessions();
      const result = sessions.map(s => {
        const topicInfo = sessionToTopic.get(s.id);
        const projectShort = s.project
          ? s.project.replace(/\\/g, '/').split('/').filter(Boolean).pop()
          : 'unknown';
        const uptimeMs = Date.now() - new Date(s.createdAt || Date.now()).getTime();
        const uptimeStr = formatUptime(uptimeMs);

        return {
          id: s.id,
          name: s.name || s.id,
          project: s.project,
          projectShort,
          paneId: s.paneId,
          status: s.status || 'unknown',
          lastActivity: s.lastActivity || s.createdAt,
          promptType: s.promptType || null,
          isLive: liveStreams.has(s.id),
          uptime: uptimeStr,
          topicName: topicInfo?.projectName || null,
        };
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: single session
  app.get('/api/session/:id', (req, res) => {
    try {
      const session = sm.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const history = sm.getCompletionHistory(req.params.id) || [];
      res.json({
        ...session,
        completionHistory: history.slice(-10),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: trigger action
  app.post('/api/session/:id/action/:action', (req, res) => {
    try {
      const session = sm.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { action } = req.params;
      const actionMap = {
        continue: '',          // Just press Enter
        tests: 'run tests',
        commit: '/commit',
        compact: '/compact',
        review: '/review',
        diff: '!git diff --stat',
      };

      if (action === 'kill') {
        try { sm.killSession(req.params.id); } catch (killErr) {
          console.error(`[webapp] killSession failed for ${req.params.id}:`, killErr.message);
        }
        return res.json({ ok: true, action: 'kill' });
      }

      if (actionMap[action] !== undefined) {
        wez.sendText(session.paneId, actionMap[action]);
        session.status = 'running';
        session._stabilityCount = 0;
        session._lastScrollbackHash = null;
        return res.json({ ok: true, action });
      }

      res.status(400).json({ error: `Unknown action: ${action}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: bot status
  app.get('/api/status', (req, res) => {
    const sessions = sm.listSessions();
    const working = sessions.filter(s => s.status === 'running').length;
    res.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      uptimeStr: formatUptime(Date.now() - startTime),
      sessions: sessions.length,
      working,
      idle: sessions.length - working,
      version: '3.0.0',
    });
  });

  return app;
}

// Note: also defined in server.cjs (parent directory)
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

module.exports = { createApp };
