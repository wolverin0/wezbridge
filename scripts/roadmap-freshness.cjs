#!/usr/bin/env node
'use strict';
/**
 * roadmap-freshness.cjs — weekly fleet sweep: is each project's governing roadmap
 * doc fresher than its recent commits? Pilot cron of the 2026-08-21 monitoring
 * program (operator-approved, grill G15). Deterministic collector: writes evidence
 * to Py Apps/_intel/evidence/, NEVER pokes panes — the orch-waker routes it.
 * Drift rule: latest commit newer than roadmap mtime by >7 days = DRIFT.
 * Run: node scripts/roadmap-freshness.cjs   (schtasks: PyApps-RoadmapFreshness, weekly Mon 09:00)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = 'G:/_OneDrive/OneDrive/Desktop/Py Apps';
const DESKTOP = 'G:/_OneDrive/OneDrive/Desktop';
const EVIDENCE_DIR = path.join(ROOT, '_intel', 'evidence');
const DRIFT_DAYS = 7;

// project → { repo (git root), roadmap (governing doc, repo-relative or absolute) }
// Sources: 2026-08-21 sweep reports. "roadmap: null" = project has no roadmap doc (always flagged).
const PROJECTS = [
  { name: 'cerca-salud',   repo: `${DESKTOP}/doctor/cerca-salud`,                                    roadmap: 'ROADMAP.md' },
  { name: 'rifas',         repo: `${ROOT}/rifas`,                                                    roadmap: 'PRD.md' },
  { name: 'yolo26',        repo: `${ROOT}/yolo26`,                                                   roadmap: 'ROADMAP.md' },
  { name: 'crm-pf',        repo: `${ROOT}/CRM/recovered-source/crm-standalone`,                      roadmap: `${ROOT}/CRM/artifacts/2026-08-20-invoicing-implementation-plan.html` },
  { name: 'memorymaster',  repo: `${ROOT}/memorymaster`,                                             roadmap: 'ROADMAP.md' },
  { name: 'whatsappbot',   repo: `${ROOT}/whatsappbot-prod - Copy - Copy/whatsappbot-final`,         roadmap: 'docs/capability-atlas/capability-roadmap.md' },
  { name: 'pedrito',       repo: `${ROOT}/pedrito`,                                                  roadmap: '.planning/STATE.md' },
  { name: 'infra',         repo: `${ROOT}/infra`,                                                    roadmap: null },
  { name: 'wezbridge',     repo: `${ROOT}/wezbridge`,                                                roadmap: null }, // ledger-driven by design; reported informational
];

function lastCommitEpoch(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    return parseInt(out.trim(), 10) * 1000 || null;
  } catch { return null; }
}

function check(p) {
  const row = { name: p.name, status: 'OK', detail: '' };
  const commitMs = lastCommitEpoch(p.repo);
  if (!p.roadmap) {
    row.status = p.name === 'wezbridge' ? 'INFO' : 'NO-ROADMAP';
    row.detail = p.name === 'wezbridge' ? 'ledger-driven by design' : 'no governing roadmap doc exists';
    return row;
  }
  const roadmapPath = path.isAbsolute(p.roadmap) || /^[A-Za-z]:/.test(p.roadmap)
    ? p.roadmap : path.join(p.repo, p.roadmap);
  if (!fs.existsSync(roadmapPath)) {
    row.status = 'MISSING';
    row.detail = `${p.roadmap} not found`;
    return row;
  }
  const roadmapMs = fs.statSync(roadmapPath).mtimeMs;
  if (!commitMs) {
    row.status = 'NO-GIT';
    row.detail = 'could not read git log';
    return row;
  }
  const lagDays = (commitMs - roadmapMs) / 86400000;
  row.detail = `roadmap ${new Date(roadmapMs).toISOString().slice(0, 10)}, last commit ${new Date(commitMs).toISOString().slice(0, 10)}`;
  if (lagDays > DRIFT_DAYS) {
    row.status = 'DRIFT';
    row.detail += ` — commits lead by ${Math.round(lagDays)}d`;
  }
  return row;
}

function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const rows = PROJECTS.map(check);
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);
  const flagged = rows.filter((r) => ['DRIFT', 'MISSING', 'NO-ROADMAP', 'NO-GIT'].includes(r.status));

  const md = [
    `# Roadmap freshness sweep — ${day}`,
    `Generated ${stamp} by wezbridge/scripts/roadmap-freshness.cjs (weekly cron).`,
    `Rule: last commit newer than governing roadmap by >${DRIFT_DAYS} days = DRIFT.`,
    `Flagged: ${flagged.length}/${rows.length}. Read when: orch-waker fires on this file or weekly triage.`,
    `Owner routing: each project's own pane fixes its roadmap; orchestrator dispatches.`,
    '', '| project | status | detail |', '|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.status} | ${r.detail} |`),
  ].join('\n');

  const mdPath = path.join(EVIDENCE_DIR, `roadmap-freshness-${day}.md`);
  fs.writeFileSync(mdPath, md + '\n');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'roadmap-freshness-latest.json'),
    JSON.stringify({ generated: stamp, flagged: flagged.length, rows }, null, 2) + '\n');
  console.log(`[roadmap-freshness] ${flagged.length}/${rows.length} flagged → ${mdPath}`);
  for (const r of rows) console.log(`  ${r.status.padEnd(11)} ${r.name.padEnd(14)} ${r.detail}`);
}

main();
