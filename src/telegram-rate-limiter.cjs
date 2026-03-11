/**
 * Telegram Rate Limiter — per-chat message queue respecting ~20 msgs/min limit.
 * Ensures minimum 1100ms between messages to the same chat.
 * Auto-retries on 429 (Too Many Requests) with Telegram's retry_after backoff.
 */

const MIN_INTERVAL_MS = 1100;

class TelegramRateLimiter {
  constructor() {
    // Per-chat queues: Map<chatId, { queue: Array, processing: boolean, lastSent: number }>
    this.chats = new Map();
  }

  /**
   * Enqueue a Telegram API call for a specific chat.
   * @param {string|number} chatId - The chat to rate-limit for
   * @param {Function} fn - Async function that performs the API call (must return the result)
   * @returns {Promise} Resolves with the API call result
   */
  enqueue(chatId, fn) {
    const key = String(chatId);
    if (!this.chats.has(key)) {
      this.chats.set(key, { queue: [], processing: false, lastSent: 0 });
    }

    const chat = this.chats.get(key);

    return new Promise((resolve, reject) => {
      chat.queue.push({ fn, resolve, reject, _retries: 0 });
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
      const { fn, resolve, reject, _retries } = chat.queue.shift();

      // Wait for minimum interval
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
        // Handle 429 Too Many Requests
        if (err?.response?.statusCode === 429) {
          const newRetries = (_retries || 0) + 1;
          if (newRetries >= 3) {
            console.error(`[rate-limiter] 429 for chat ${key}, max retries (${newRetries}) reached — rejecting`);
            reject(err);
          } else {
            const retryAfter = (err.response?.body?.parameters?.retry_after || 5) * 1000;
            console.log(`[rate-limiter] 429 for chat ${key}, retry ${newRetries}/3, waiting ${retryAfter}ms`);
            await this._sleep(retryAfter);
            // Re-queue the failed call at the front
            chat.queue.unshift({ fn, resolve, reject, _retries: newRetries });
          }
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
