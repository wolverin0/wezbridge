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

export interface BoardState {
  generated_at: string;
  gate: {
    verdict: 'GREEN' | 'RED';
    unruled: number;
    last_run_at: string | null;
    last_run_text: string;
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
