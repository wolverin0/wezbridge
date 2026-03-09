/**
 * Example WezBridge plugin — demonstrates the plugin API.
 *
 * Plugins export { name, register(ctx) } where ctx provides:
 *   ctx.sendMsg(chatId, text, opts)  — Send a Telegram message
 *   ctx.sessions                     — Session manager (spawnSession, listSessions, etc.)
 *   ctx.wezterm                      — WezTerm CLI wrapper
 *   ctx.bot                          — Raw TelegramBot instance
 *   ctx.registerCommand(name, handler) — Register a /command
 *   ctx.registerButton(actionId, handler) — Register a callback button
 *   ctx.on(event, handler)           — Listen to session events
 *
 * To activate: rename this file to remove the .example suffix,
 * or create your own .cjs file in the plugins/ directory.
 */

module.exports = {
  name: 'example',

  register(ctx) {
    // Example: log when sessions become idle
    ctx.on('session:waiting', (session) => {
      console.log(`[example-plugin] Session ${session.id} is now waiting`);
    });

    // Example: register a custom command
    // ctx.registerCommand('ping', (msg) => {
    //   ctx.sendMsg(msg.chat.id, 'Pong!', { message_thread_id: msg.message_thread_id });
    // });
  },
};
