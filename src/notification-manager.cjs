/**
 * Notification Manager — batches and prioritizes Telegram notifications.
 * Buffers completions for 5 seconds, groups concurrent ones into a single message.
 * Errors always send immediately.
 */

const BUFFER_MS = 5000;
const NOTIFY_LEVELS = ['all', 'errors', 'none'];

class NotificationManager {
  /**
   * @param {object} opts
   * @param {Function} opts.sendMsg - async (chatId, text, opts) => msg
   * @param {Function} opts.sendDocument - async (chatId, doc, opts, caption) => msg
   * @param {string} [opts.level] - 'all' | 'errors' | 'none'
   */
  constructor({ sendMsg, sendDocument, level = 'all' }) {
    this.sendMsg = sendMsg;
    this.sendDocument = sendDocument;
    this.level = NOTIFY_LEVELS.includes(level) ? level : 'all';

    // Buffer: Map<chatId, { timer, items: Array<{text, topicId, priority, keyboard}> }>
    this.buffers = new Map();
  }

  /**
   * Queue a notification. Errors send immediately; others buffer.
   * @param {object} opts
   * @param {string|number} opts.chatId
   * @param {number} opts.topicId
   * @param {string} opts.text - HTML-formatted text
   * @param {'error'|'success'|'info'} opts.priority
   * @param {object} [opts.keyboard] - Inline keyboard markup
   */
  notify({ chatId, topicId, text, priority = 'info', keyboard }) {
    if (this.level === 'none') return;
    if (this.level === 'errors' && priority !== 'error') return;

    // Errors always send immediately
    if (priority === 'error') {
      return this._sendNow(chatId, topicId, text, keyboard);
    }

    // Buffer others
    const key = String(chatId);
    if (!this.buffers.has(key)) {
      this.buffers.set(key, { timer: null, items: [] });
    }
    const buf = this.buffers.get(key);
    buf.items.push({ text, topicId, priority, keyboard });

    // Reset timer
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this._flush(key), BUFFER_MS);
  }

  async _flush(key) {
    const buf = this.buffers.get(key);
    if (!buf || buf.items.length === 0) return;

    const items = [...buf.items];
    buf.items = [];
    buf.timer = null;
    this.buffers.delete(key);

    const chatId = parseInt(key, 10) || key;

    if (items.length === 1) {
      // Single notification — send as-is
      const item = items[0];
      return this._sendNow(chatId, item.topicId, item.text, item.keyboard);
    }

    // Multiple notifications — group by topic
    const byTopic = new Map();
    for (const item of items) {
      const topicKey = item.topicId || 'general';
      if (!byTopic.has(topicKey)) byTopic.set(topicKey, []);
      byTopic.get(topicKey).push(item);
    }

    for (const [topicId, topicItems] of byTopic) {
      if (topicItems.length === 1) {
        const item = topicItems[0];
        await this._sendNow(chatId, topicId === 'general' ? undefined : topicId, item.text, item.keyboard);
      } else {
        // Combine into summary
        const lines = topicItems.map(it => it.text).join('\n\n---\n\n');
        const lastKeyboard = topicItems[topicItems.length - 1].keyboard;
        const header = `<b>${topicItems.length} updates:</b>\n\n`;
        await this._sendNow(chatId, topicId === 'general' ? undefined : topicId, header + lines, lastKeyboard);
      }
    }
  }

  async _sendNow(chatId, topicId, text, keyboard) {
    try {
      const opts = {};
      if (topicId) opts.message_thread_id = topicId;
      if (keyboard) Object.assign(opts, keyboard);
      await this.sendMsg(chatId, text, opts);
    } catch (err) {
      console.error('[notify] Failed to send:', err.message);
    }
  }

  /**
   * Send a document (for large diffs, exports, etc.).
   */
  async sendDoc(chatId, topicId, buffer, filename, caption) {
    if (this.level === 'none') return;
    try {
      const opts = {};
      if (topicId) opts.message_thread_id = topicId;
      await this.sendDocument(chatId, buffer, opts, { caption, filename });
    } catch (err) {
      console.error('[notify] Failed to send document:', err.message);
    }
  }
}

module.exports = NotificationManager;
