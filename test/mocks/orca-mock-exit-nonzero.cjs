#!/usr/bin/env node
'use strict';
// orca-mock-exit-nonzero.cjs — T-0596 regression fixture: reproduces the REAL
// orca.exe behavior measured 2026-09-24 (a stale-handle refusal) — a
// well-formed {ok:false,...} JSON body on stdout, paired with a non-zero exit
// code. defaultRunOrca (src/orca-send.cjs, src/orca-census.cjs) must resolve
// with the stdout body instead of discarding it as a transport failure.
process.stdout.write(JSON.stringify({
  id: 'test-request-id',
  ok: false,
  error: {
    code: 'terminal_handle_stale',
    message: 'terminal_handle_stale Terminal prompt request ID: test-request-id. Re-issue with --retry-request test-request-id --wait-submit <seconds>.',
  },
}));
process.exit(1);
