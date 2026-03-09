/**
 * Plugin Loader — discovers and loads user plugins from plugins/ directory.
 * Plugins export { name, register(ctx) } where ctx gives access to
 * session events, button registration, command registration, sendMsg, and wezterm.
 */
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

class PluginLoader {
  constructor() {
    this.plugins = new Map();
    this.commands = new Map();    // pluginName:command → handler
    this.buttons = new Map();     // pluginName:action → handler
    this.eventHandlers = [];      // [{plugin, event, handler}]
  }

  /**
   * Create a plugin context object.
   * @param {object} deps - Dependencies to inject
   * @returns {object} Plugin context
   */
  createContext(deps) {
    const self = this;
    return {
      // Send a message to Telegram
      sendMsg: deps.sendMsg,

      // Session manager access
      sessions: deps.sessionManager,

      // WezTerm access
      wezterm: deps.wezterm,

      // Bot instance (for advanced use)
      bot: deps.bot,

      // Register a command handler (e.g., /myplugin-foo)
      registerCommand(name, handler) {
        self.commands.set(name, handler);
      },

      // Register a button callback handler
      registerButton(actionId, handler) {
        self.buttons.set(actionId, handler);
      },

      // Listen to session events
      on(event, handler) {
        self.eventHandlers.push({ event, handler });
        deps.sessionManager.events.on(event, handler);
      },
    };
  }

  /**
   * Discover and load all plugins from the plugins directory.
   * @param {object} deps - Dependencies for plugin context
   * @returns {Array<string>} Names of loaded plugins
   */
  loadAll(deps) {
    if (!fs.existsSync(PLUGINS_DIR)) {
      try {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      } catch { /* ignore */ }
      return [];
    }

    const loaded = [];

    try {
      const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));

      for (const file of files) {
        try {
          const pluginPath = path.join(PLUGINS_DIR, file);
          const plugin = require(pluginPath);

          if (!plugin.name || typeof plugin.register !== 'function') {
            console.warn(`[plugins] Skipping ${file}: missing name or register function`);
            continue;
          }

          const ctx = this.createContext(deps);
          plugin.register(ctx);
          this.plugins.set(plugin.name, plugin);
          loaded.push(plugin.name);
          console.log(`[plugins] Loaded: ${plugin.name} (${file})`);
        } catch (err) {
          console.error(`[plugins] Failed to load ${file}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[plugins] Failed to read plugins directory:', err.message);
    }

    return loaded;
  }

  /**
   * Handle a command from Telegram. Returns true if handled by a plugin.
   */
  handleCommand(commandName, msg) {
    const handler = this.commands.get(commandName);
    if (!handler) return false;
    try {
      handler(msg);
    } catch (err) {
      console.error(`[plugins] Command ${commandName} error:`, err.message);
    }
    return true;
  }

  /**
   * Handle a callback button press. Returns true if handled by a plugin.
   */
  handleButton(actionId, query) {
    const handler = this.buttons.get(actionId);
    if (!handler) return false;
    try {
      handler(query);
    } catch (err) {
      console.error(`[plugins] Button ${actionId} error:`, err.message);
    }
    return true;
  }

  /**
   * List loaded plugins.
   */
  list() {
    return [...this.plugins.keys()];
  }
}

module.exports = PluginLoader;
