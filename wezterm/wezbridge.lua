-- wezbridge.wezterm — Lua plugin for crash recovery + AI launcher
--
-- After a wezterm crash, this plugin can:
--   1. Auto-restore the most recent session-snapshot if it's <30 min old
--      and contains 2+ AI panes (silent — no prompt, no clicks).
--   2. Bind a keybind (default LEADER+R) that opens an InputSelector
--      fuzzy picker over all snapshots, lets you pick which to restore.
--   3. Bind a keybind (default LEADER+L) that opens a launcher menu of
--      preset AI launches (claude --continue, claude --channels, codex
--      resume --last, etc.) so you don't have to remember the flags.
--
-- The plugin reads the same JSONL log wezbridge's session-snapshot.cjs
-- daemon writes to:
--   <wezbridge_repo>/vault/_wezbridge/session-snapshot.jsonl
--
-- Usage in your wezterm.lua:
--
--   local wezterm = require 'wezterm'
--   local config = wezterm.config_builder()
--   local wezbridge = require 'wezbridge'
--   wezbridge.apply(config, {
--     wezbridge_dir = 'G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge',
--     auto_restore = true,
--     auto_restore_max_age_min = 30,
--     restore_keybind = { mods = 'LEADER', key = 'r' },
--     launcher_keybind = { mods = 'LEADER', key = 'l' },
--   })
--   return config

local wezterm = require 'wezterm'
local M = {}

-- ============================================================
-- Snapshot reading
-- ============================================================

--- Read all snapshot entries from the JSONL log. Skips malformed lines.
local function read_all_snapshots(path)
  local entries = {}
  local f = io.open(path, 'r')
  if not f then return entries end
  for line in f:lines() do
    if line and #line > 0 then
      local ok, e = pcall(wezterm.json_parse, line)
      if ok and type(e) == 'table' and e.snapshot_ts then
        table.insert(entries, e)
      end
    end
  end
  f:close()
  return entries
end

--- Group entries by snapshot_ts. Returns array of { ts, entries }, newest first.
local function group_by_ts(entries)
  local by_ts = {}
  for _, e in ipairs(entries) do
    by_ts[e.snapshot_ts] = by_ts[e.snapshot_ts] or {}
    table.insert(by_ts[e.snapshot_ts], e)
  end
  local groups = {}
  for ts, group in pairs(by_ts) do
    table.insert(groups, { ts = ts, entries = group })
  end
  table.sort(groups, function(a, b) return a.ts > b.ts end)
  return groups
end

--- Parse an ISO-8601 UTC timestamp into epoch seconds. Returns nil on failure.
local function iso_to_epoch(iso)
  if not iso then return nil end
  local y, mo, d, h, mi, s = iso:match('(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)')
  if not y then return nil end
  -- snapshot_ts is UTC (trailing Z) but os.time() interprets the fields as
  -- LOCAL time — at UTC-3 every snapshot looked 3h in the future ("-180 min
  -- ago" in the picker) and the auto-restore age gate was skewed the same way.
  local local_interp = os.time({
    year = tonumber(y), month = tonumber(mo), day = tonumber(d),
    hour = tonumber(h), min = tonumber(mi), sec = tonumber(s),
  })
  local now = os.time()
  local utc_offset = os.difftime(now, os.time(os.date('!*t', now)))
  return local_interp + utc_offset
end

--- Signature of a snapshot group's LAYOUT: which AI panes in which cwds.
--- Consecutive 60s ticks of an unchanged workspace produce identical
--- signatures — the picker collapses them to the newest occurrence.
local function layout_signature(entries)
  local parts = {}
  for _, e in ipairs(entries) do
    table.insert(parts, string.format('%s|%s', e.ai or '?', e.cwd or '?'))
  end
  table.sort(parts)
  return table.concat(parts, ';')
end

--- Returns the most-recent snapshot batch as an array of entries, or nil.
local function latest_snapshot(path)
  local groups = group_by_ts(read_all_snapshots(path))
  if #groups == 0 then return nil end
  return groups[1].entries, groups[1].ts
end

-- ============================================================
-- Cmdline parsing (same logic as scripts/restore-session.cjs splitCmdline)
-- ============================================================

local function split_cmdline(cmdline)
  local out = {}
  if not cmdline or #cmdline == 0 then return out end
  local cur = ''
  local q = nil
  for i = 1, #cmdline do
    local c = cmdline:sub(i, i)
    if q then
      if c == q then q = nil
      else cur = cur .. c end
    elseif c == '"' or c == "'" then
      q = c
    elseif c == ' ' or c == '\t' then
      if #cur > 0 then table.insert(out, cur); cur = '' end
    else
      cur = cur .. c
    end
  end
  if #cur > 0 then table.insert(out, cur) end
  return out
end

-- ============================================================
-- Spawn helpers
-- ============================================================

local function spawn_entries(entries, opts)
  opts = opts or {}
  local stagger_ms = opts.stagger_ms or 2000
  local mux = wezterm.mux
  local first_window
  for i, e in ipairs(entries) do
    local args = split_cmdline(e.cmdline)
    if #args > 0 then
      local spawn_opts = { args = args, cwd = e.cwd }
      if i == 1 then
        local _, _, win = mux.spawn_window(spawn_opts)
        first_window = win
      else
        if first_window then
          first_window:spawn_tab(spawn_opts)
        else
          mux.spawn_window(spawn_opts)
        end
      end
      if i < #entries and stagger_ms > 0 then
        wezterm.sleep_ms(stagger_ms)
      end
    end
  end
end

-- ============================================================
-- Auto-restore on mux-startup
-- ============================================================

local function setup_auto_restore(opts)
  local snapshot_path = opts.wezbridge_dir .. '/vault/_wezbridge/session-snapshot.jsonl'
  local max_age_sec = (opts.auto_restore_max_age_min or 30) * 60
  local min_entries = opts.auto_restore_min_entries or 2

  wezterm.on('mux-startup', function()
    local entries, ts = latest_snapshot(snapshot_path)
    if not entries or #entries < min_entries then
      wezterm.log_info('wezbridge: no snapshot to auto-restore (have ' .. (entries and #entries or 0) .. ' entries, need ' .. min_entries .. ')')
      return
    end
    local epoch = iso_to_epoch(ts)
    local age_sec = epoch and (os.time() - epoch) or math.huge
    if age_sec > max_age_sec then
      wezterm.log_info('wezbridge: snapshot is ' .. math.floor(age_sec / 60) .. ' min old (max ' .. (max_age_sec / 60) .. '), skipping auto-restore. Use ' .. (opts.restore_keybind and (opts.restore_keybind.mods .. '+' .. opts.restore_keybind.key) or 'manual restore') .. ' to pick.')
      return
    end
    wezterm.log_info('wezbridge: auto-restoring ' .. #entries .. ' AI panes from snapshot ' .. ts)
    spawn_entries(entries, { stagger_ms = opts.stagger_ms or 2000 })
  end)
end

-- ============================================================
-- Pane recorder launch on mux-startup
-- ============================================================

-- The recorder (the :4200 daemon) used to auto-start at Windows logon. WezTerm
-- does not start with Windows, so it always came up to a machine with no panes;
-- on 2026-08-13 it died after its first failed discovery tick and recorded
-- nothing for 9 hours, which is how a reboot lost the fleet layout. Tying it to
-- mux-startup means it starts exactly when there is something to record, and
-- the race cannot exist. start-recorder.cmd refuses to start a second instance.
local function setup_recorder(opts)
  local script = opts.wezbridge_dir .. '/scripts/start-recorder.cmd'
  wezterm.on('mux-startup', function()
    local ok_spawn, err = pcall(function()
      wezterm.background_child_process { 'cmd.exe', '/c', script }
    end)
    if ok_spawn then
      wezterm.log_info('wezbridge: pane recorder launch requested')
    else
      -- Never fatal: a missing recorder must not stop WezTerm from starting.
      wezterm.log_error('wezbridge: could not launch pane recorder: ' .. tostring(err))
    end
  end)
end

-- ============================================================
-- Recent-sessions fuzzy picker (LEADER+r by default)
-- ============================================================

local function setup_restore_keybind(config, opts)
  if not opts.restore_keybind then return end
  local snapshot_path = opts.wezbridge_dir .. '/vault/_wezbridge/session-snapshot.jsonl'
  config.keys = config.keys or {}
  table.insert(config.keys, {
    mods = opts.restore_keybind.mods,
    key = opts.restore_keybind.key,
    action = wezterm.action_callback(function(window, pane)
      local groups = group_by_ts(read_all_snapshots(snapshot_path))
      if #groups == 0 then
        window:toast_notification('wezbridge', 'No snapshots found.', nil, 4000)
        return
      end
      -- The watcher ticks every 60s, so raw groups flood the picker with
      -- near-identical entries. Collapse consecutive identical LAYOUTS
      -- (same AI panes in same cwds) to their newest occurrence, cap at 15.
      local choices = {}
      local seen_sig = {}
      for _, g in ipairs(groups) do
        local sig = layout_signature(g.entries)
        if not seen_sig[sig] then
          seen_sig[sig] = true
          local epoch = iso_to_epoch(g.ts)
          local age = epoch and math.floor((os.time() - epoch) / 60) or -1
          local label = string.format('%s · %d panes · %d min ago', g.ts, #g.entries, age)
          table.insert(choices, { id = g.ts, label = label })
          if #choices >= 15 then break end
        end
      end
      window:perform_action(wezterm.action.InputSelector({
        title = 'Restore wezbridge snapshot',
        choices = choices,
        action = wezterm.action_callback(function(_, _, id, label)
          if not id then return end
          for _, g in ipairs(groups) do
            if g.ts == id then
              spawn_entries(g.entries, { stagger_ms = opts.stagger_ms or 2000 })
              return
            end
          end
        end),
      }), pane)
    end),
  })
end

-- ============================================================
-- Launcher menu (LEADER+l by default)
-- ============================================================

local DEFAULT_LAUNCH_PRESETS = {
  { label = 'Claude — continue',                      args = { 'claude', '--continue' } },
  { label = 'Claude — continue + dangerously skip',   args = { 'claude', '--continue', '--dangerously-skip-permissions' } },
  { label = 'Claude — channels (telegram) + continue',args = { 'claude', '--channels', 'plugin:telegram@claude-plugins-official', '--continue', '--dangerously-skip-permissions' } },
  { label = 'Claude — fresh',                         args = { 'claude' } },
  { label = 'Codex — resume last',                    args = { 'codex', 'resume', '--last' } },
  { label = 'Codex — fresh',                          args = { 'codex' } },
}

local function setup_launcher_keybind(config, opts)
  if not opts.launcher_keybind then return end
  local presets = opts.launch_presets or DEFAULT_LAUNCH_PRESETS
  config.keys = config.keys or {}
  table.insert(config.keys, {
    mods = opts.launcher_keybind.mods,
    key = opts.launcher_keybind.key,
    action = wezterm.action_callback(function(window, pane)
      local choices = {}
      for _, p in ipairs(presets) do
        table.insert(choices, { label = p.label, id = p.label })
      end
      window:perform_action(wezterm.action.InputSelector({
        title = 'Launch AI session',
        choices = choices,
        action = wezterm.action_callback(function(w, p, id, label)
          if not id then return end
          for _, preset in ipairs(presets) do
            if preset.label == id then
              local cwd = pane:get_current_working_dir()
              if cwd and cwd.file_path then cwd = cwd.file_path end
              wezterm.mux.spawn_window({ args = preset.args, cwd = cwd })
              return
            end
          end
        end),
      }), pane)
    end),
  })
end

-- ============================================================
-- Public API
-- ============================================================

--- Apply wezbridge plugin to your wezterm config.
--- @param config table — your wezterm config table (from wezterm.config_builder())
--- @param opts table   — { wezbridge_dir, auto_restore, auto_restore_max_age_min,
---                          auto_restore_min_entries, restore_keybind, launcher_keybind,
---                          launch_presets, stagger_ms, start_recorder }
function M.apply(config, opts)
  opts = opts or {}
  if not opts.wezbridge_dir then
    error('wezbridge.apply: opts.wezbridge_dir is required (path to your wezbridge repo)')
  end
  -- Opt-IN: starting a background daemon is a side effect nobody should get by
  -- surprise from a terminal config. The auto-restore below depends on the
  -- recorder having run, so the two belong to the same decision.
  if opts.start_recorder then
    setup_recorder(opts)
  end
  if opts.auto_restore ~= false then
    setup_auto_restore(opts)
  end
  setup_restore_keybind(config, opts)
  setup_launcher_keybind(config, opts)
end

-- Expose helpers for testing
M._read_all_snapshots = read_all_snapshots
M._group_by_ts = group_by_ts
M._iso_to_epoch = iso_to_epoch
M._split_cmdline = split_cmdline
M._latest_snapshot = latest_snapshot
M.DEFAULT_LAUNCH_PRESETS = DEFAULT_LAUNCH_PRESETS

return M
