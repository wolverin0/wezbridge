import type { ActivityPage, BoardState, RulingLine, Verb } from './types';

const TOKEN_KEY = 'board-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t.trim());
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'x-board-token': getToken(),
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, 'sin conexión con el servidor');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
  return body as T;
}

export const fetchState = () => call<BoardState>('/api/state');

export const fetchActivity = (page: number) => call<ActivityPage>(`/api/activity?page=${page}`);

export const postRuling = (input: { task: string; verb: Verb; until?: string; note: string }) =>
  call<{ ok: true; line: RulingLine }>('/api/rulings', { method: 'POST', body: JSON.stringify(input) });

export const postInbox = (input: { kind: 'note' | 'new-task' | 'call-me'; text: string }) =>
  call<{ ok: true; line: unknown }>('/api/orchestrator-inbox', { method: 'POST', body: JSON.stringify(input) });
