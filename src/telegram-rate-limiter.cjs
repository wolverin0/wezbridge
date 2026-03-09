/**
 * Telegram Rate Limiter — per-chat message queue respecting ~20 msgs/min limit.
 */

const MIN_INTERVAL_MS = 1100;

class TelegramRateLimiter {
  constructor() {
    this.chats = new Map();
  }

  enqueue(chatId, fn) {
    const key = String(chatId);
    if (!this.chats.has(key)) {
      this.chats.set(key, { queue: [], processing: false, lastSent: 0 });
    }

    const chat = this.chats.get(key);

    return new Promise((resolve, reject) => {
      chat.queue.push({ fn, resolve, reject });
      if (!chat.processing) {
        this._process(key);
      }
    });
  }

  async _process(key) {
    const chat = this.chats.get(key);
    if (!chat || chat.processing) return;
    chat.processing = true;

    while (chat.queue.length > 0) {
      const { fn, resolve, reject } = chat.queue.shift();

      const now = Date.now();
      const elapsed = now - chat.lastSent;
      if (elapsed < MIN_INTERVAL_MS) {
        await this._sleep(MIN_INTERVAL_MS - elapsed);
      }

      try {
        const result = await fn();
        chat.lastSent = Date.now();
        resolve(result);
      } catch (err) {
        if (err?.response?.statusCode === 429) {
          const retryAfter = (err.response?.body?.parameters?.retry_after || 5) * 1000;
          console.log(`[rate-limiter] 429 for chat ${key}, waiting ${retryAfter}ms`);
          await this._sleep(retryAfter);
          chat.queue.unshift({ fn, resolve, reject });
        } else {
          reject(err);
        }
      }
    }

    chat.processing = false;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = TelegramRateLimiter;
