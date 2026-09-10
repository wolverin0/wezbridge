-- Pure plugin rehearsal in Lua. All mux and file operations are doubles.
local actual_wezterm = require 'wezterm'
local actual_open = io.open
local profile_present = true
local callbacks, spawned = {}, {}
local now = os.date('!%Y-%m-%dT%H:%M:%SZ')
local rows = {
  { snapshot_ts = now, ai = 'claude', cwd = 'G:/Fixture Apps/wezbridge', cmdline = 'claude --continue' },
  { snapshot_ts = now, ai = 'claude', cwd = 'G:/Fixture Apps/other', cmdline = 'claude --continue' },
}
local fake = {
  on = function(name, callback) callbacks[name] = callback end,
  json_parse = function(line) return rows[tonumber(line)] end,
  log_info = function() end,
  log_error = function(message) error(message) end,
  sleep_ms = function() end,
  mux = {},
}
local window = { spawn_tab = function(_, opts) table.insert(spawned, opts) end }
fake.mux.spawn_window = function(opts)
  table.insert(spawned, opts)
  return nil, nil, window
end
io.open = function(file, mode)
  if file:match('session%-snapshot%.jsonl$') then
    return { close = function() end, lines = function()
      local i = 0
      return function() i = i + 1; if rows[i] then return tostring(i) end end
    end }
  end
  if file:match('orchestrator%-session%.json$') then
    if profile_present then return { close = function() end } end
    return nil
  end
  return actual_open(file, mode)
end
package.loaded.wezterm = fake
local plugin = dofile(assert(os.getenv('WEZBRIDGE_LUA_MODULE')))
plugin.apply({}, { wezbridge_dir = 'G:/Fixture Apps/wezbridge', auto_restore = true })
callbacks['mux-startup']()
assert(#spawned == 1, 'selected orchestrator must be recovered by the watchdog, not replayed as Claude by Lua')
assert(spawned[1].cwd == 'G:/Fixture Apps/other', 'other project restoration must remain available')
profile_present, spawned = false, {}
callbacks['mux-startup']()
assert(#spawned == 2, 'unconfigured installations retain their snapshot behavior')
io.open = actual_open
package.loaded.wezterm = actual_wezterm
print('ASTRA_RESTORE_LUA_PASS')
return actual_wezterm.config_builder()
