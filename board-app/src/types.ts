// Mirrors of the server payloads (server.cjs is the source of truth).

export interface Decision {
  id: string;
  repo: string;
  title: string;
  state: string;
  updated_at: string | null;
  question: string;
  category: string;
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
}

export interface RepoTask {
  id: string;
  title: string;
  state: string;
  updated_at: string | null;
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
