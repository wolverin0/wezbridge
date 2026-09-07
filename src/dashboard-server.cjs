#!/usr/bin/env node
'use strict';

// Inherited by children, but matches only this process: workers may run sync CLI.
process.env.WEZBRIDGE_DAEMON_OWNER_PID = String(process.pid);
const { startServer } = require('./dashboard-server-routes.cjs');

startServer();
