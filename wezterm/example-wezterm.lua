-- Example ~/.wezterm.lua snippet to enable the wezbridge plugin.
-- Paste the relevant block into YOUR wezterm.lua (typically at
-- C:\Users\<you>\.wezterm.lua on Windows or ~/.config/wezterm/wezterm.lua
-- on Linux/macOS).
--
-- This example assumes your wezbridge repo is at the path below; edit
-- `wezbridge_dir` if you cloned it somewhere else.

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- ====================================================================
-- 1. Add wezbridge's wezterm/ directory to Lua's package.path so we can
--    require it as `wezbridge`. Adjust the path to where you cloned the
--    wezbridge repo.
-- ====================================================================
local wezbridge_dir = 'G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge'
package.path = package.path .. ';' .. wezbridge_dir .. '/wezterm/?.lua'

-- ====================================================================
-- 2. (Optional, recommended) set a leader key. The default keybinds
--    below use LEADER+R and LEADER+L.
-- ====================================================================
config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 2000 }

-- ====================================================================
-- 3. Apply the wezbridge plugin.
-- ====================================================================
local wezbridge = require 'wezbridge'
wezbridge.apply(config, {
  wezbridge_dir = wezbridge_dir,

  -- Auto-restore the most recent snapshot on mux-startup (after a crash
  -- or fresh wezterm boot). Skips if snapshot is older than max_age_min
  -- or has fewer than min_entries panes.
  auto_restore = true,
  auto_restore_max_age_min = 30,
  auto_restore_min_entries = 2,

  -- LEADER+R → fuzzy picker over ALL snapshots in the log.
  restore_keybind = { mods = 'LEADER', key = 'r' },

  -- LEADER+L → launcher menu of preset AI launches (claude --continue,
  -- claude --channels, codex resume --last, etc.). Override the list
  -- by passing launch_presets = { ... }.
  launcher_keybind = { mods = 'LEADER', key = 'l' },

  -- Optional: ms to wait between spawns when restoring multiple panes.
  -- Defaults to 2000ms — tuned to give the telegram channel-plugin's
  -- bun.exe time to settle if any restored pane uses --channels.
  stagger_ms = 2000,
})

return config
