// Mirrors of the server payloads (server.cjs is the source of truth).

/** Everything the task file knows that the operator needs in order to decide. */
export interface TaskDetail {
  goal: string;
  next_action: string;
  blocker: string;
  acceptance_criteria: string[];
  depends_on: string[];
  context_refs: string[];
  corr: string;
  kind: string;
  repo: string;
  attempt: number | null;
  contract_mode: string | null;
  lease: { owner: string | null; expires_at: string | null } | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Slice 4 join: what the fleet's own records say happened for this task. */
export interface Evidence {
  last_result: {
    corr: string;
    at: string | null;
    from_pane: number | null;
    v2: string | null;
    excerpt: string;
    truncated: boolean;
  } | null;
  last_commit: { sha: string | null; at: string | null } | null;
}

export interface Decision {
  id: string;
  repo: string;
  title: string;
  state: string;
  updated_at: string | null;
  question: string;
  category: string;
  /** Absent on steward-finding cards, which have no task file behind them. */
  detail?: TaskDetail;
  evidence?: Evidence;
}

export interface DeferredHidden {
  id: string;
  repo: string;
  title: string;
  until: string | null;
  why: string;
}

/** What the server did to the task after writing the ruling. */
export interface Transition {
  applied: boolean;
  from?: string;
  to?: string;
  ungated?: boolean;
  /** State moved but the operator gate survived — the card will NOT leave. */
  still_gated?: boolean;
  reason?: string;
  error?: string;
}

export interface Finding {
  id: string;
  repo: string;
  title: string;
  category: string;
  age_hours: number;
  why: string;
  unruled: boolean;
}

export interface InFlight {
  id: string;
  repo: string;
  title: string;
  state: string;
  owner: string | null;
  updated_at: string | null;
  detail: TaskDetail;
  evidence?: Evidence;
}

export interface RepoTask {
  id: string;
  title: string;
  state: string;
  updated_at: string | null;
  detail: TaskDetail;
}

export interface RoutineRun {
  routine: string;
  repo: string;
  cadence_hours: number;
  exit_status: number;
  at: number;
  verdict: string;
}

export interface RulingLine {
  task: string;
  category: string;
  ruling: string;
  why: string;
  at: string;
  until?: string;
}

// ── Observabilidad del motor (2026-08-23) ──────────────────────────────────
// Six independent sources. EVERY one carries its own generated_at and may
// carry its own `error`: the whole reason this is six objects and not one is
// that a single timestamp over six panels lets five fresh ones vouch for a
// dead one.

interface SourceMeta {
  generated_at: string;
  error?: string;
}

export interface BriefItem {
  key: string;
  label: string;
  file: string;
  /** File mtime: the "última corrida" the operator reads. */
  last_run_at: string | null;
  text: string | null;
  truncated?: boolean;
  /** Absent is not a failure for alert files that only exist when something broke. */
  missing?: boolean;
}

export interface HermesJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  state: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  failure_streak: number;
  completed: number;
}

export interface HermesRun {
  job_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface QueueProject {
  project: string;
  total?: number;
  delivered?: number;
  undelivered?: number;
  oldest_undelivered_at?: string | null;
  oldest_undelivered_minutes?: number | null;
  error?: string;
}

export interface ActionRow {
  at: string | null;
  actor: string;
  action: string;
  target: string;
  why: string;
  extra: string;
}

export type WakeClass = 'results-directed' | 'real-stall' | 'exception' | 'noise';

export interface CensusItem {
  name: string;
  class: 'ok' | 'silent-failure' | 'contract-signal' | 'never-ran' | 'running' | 'disabled';
  note: string | null;
  lastRun: string;
  lastResult: string;
  nextRun: string;
}

export interface Observability {
  generated_at: string;
  briefs: SourceMeta & { items?: BriefItem[] };
  hermes_cron: SourceMeta & {
    jobs?: HermesJob[];
    jobs_updated_at?: string | null;
    runs?: HermesRun[] | null;
    runs_error?: string;
    runs_hint?: string;
  };
  queues: SourceMeta & {
    projects?: QueueProject[];
    flags?: number | null;
    pending?: number | null;
    total_undelivered?: number;
  };
  actions: SourceMeta & { items?: ActionRow[]; count?: number };
  rollup: SourceMeta & {
    newest?: string | null;
    newest_date?: string | null;
    expected?: string;
    ran?: boolean;
    today_local?: string;
    next_run_local?: string;
    text?: string | null;
    truncated?: boolean;
    file_at?: string | null;
  };
  waker: SourceMeta & {
    window?: number;
    total?: number;
    woke?: number;
    skipped?: number;
    classes?: Record<WakeClass, number>;
    actions?: Record<string, number>;
    last_turn_at?: string | null;
    last_turn_age_minutes?: number | null;
    last_reasons?: string[];
  };
  /** `pending` on the very first poll: the census is read off-thread. */
  census: {
    status: 'pending' | 'ok' | 'error' | 'disabled';
    generated_at?: string | null;
    items: CensusItem[];
    silent: CensusItem[];
    error?: string;
  };
}

export interface BoardState {
  generated_at: string;
  gate: {
    verdict: 'GREEN' | 'RED';
    unruled: number;
    last_run_at: string | null;
    last_run_text: string;
  };
  /** Board freshness (slice 4): stale work evidence with untouched open tasks. */
  freshness?: {
    verdict: 'GREEN' | 'RED' | 'UNKNOWN';
    stale: {
      repo: string;
      sha: string | null;
      evidence_kind: string;
      evidence_at: string;
      age_hours: number;
      open_tasks: string[];
    }[];
    reason?: string;
  };
  last_turn_at: string | null;
  snapshot_at: string | null;
  decisions: Decision[];
  deferred_hidden: DeferredHidden[];
  findings_list: Finding[];
  last_ruling: RulingLine | null;
  in_flight: InFlight[];
  by_repo: Record<string, RepoTask[]>;
  routines: RoutineRun[];
  sparkline: number[];
  open_count: number;
  kitchen?: { status: 'unconfigured' | 'up' | 'down'; detail?: string };
  observability?: Observability;
}

export interface ActivityItem {
  at: number;
  type: 'ruling' | 'event' | 'operator' | 'routine';
  title: string;
  detail: string;
}

export interface ActivityPage {
  generated_at: string;
  page: number;
  page_size: number;
  total: number;
  items: ActivityItem[];
}

export type Verb = 'approved' | 'deferred' | 'cancelled';
