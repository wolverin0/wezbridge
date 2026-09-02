import { useCallback, useEffect, useState } from 'react';
import { ApiError, clearToken, fetchState, getToken, postInbox, postRuling, setToken } from './api';
import type { BoardState, Verb } from './types';
import { ageMinutes, fmtDate } from './format';
import TopBar from './components/TopBar';
import Decisions from './components/Decisions';
import Fleet from './components/Fleet';
import Activity from './components/Activity';
import Motor from './components/Motor';
import Bots from './components/Bots';
import Actions from './components/Actions';
import { ErrorBox, Skeletons } from './components/bits';

type Tab = 'decisiones' | 'flota' | 'actividad';

/**
 * The centre zone's sub-view (2026-08-23).
 *
 * The spec fixes THREE zones and the desktop grid renders all three at once, so
 * the six new observability panels could not become a fourth column without
 * squeezing DECISIONES — the one zone the app exists for. They went into the
 * centre zone instead, behind a segmented control, because the split there is
 * real: FLOTA answers "what is the WORK doing", MOTOR answers "what is the
 * MACHINERY doing", BOTS answers "what did the watchers see". Same zone, same
 * question shape, three subjects.
 *
 * The one panel that did NOT go here is "quién hizo qué": it belongs to
 * ACTIVIDAD, which is always on screen on the desktop, because the operator
 * asked for it front and centre rather than one tap away.
 */
type Sub = 'trabajo' | 'motor' | 'bots';

const SUBS: Array<{ key: Sub; label: string }> = [
  { key: 'trabajo', label: 'Trabajo' },
  { key: 'motor', label: 'Motor' },
  { key: 'bots', label: 'Bots' },
];
type Toast = { id: number; kind: 'ok' | 'warn' | 'bad'; text: string; line?: string };

let toastSeq = 0;

/**
 * Confirmation copy, per verb (T-0143 D2).
 *
 * The old toast said "Fallo registrado para T-0129". In Argentina *fallo* is a
 * judicial ruling, which is what the fleet's `rulings.jsonl` vocabulary means —
 * but the operator, the only user, read it as "FAILURE recorded" on his own
 * successful action. He is the arbiter of what the words mean here. The word is
 * banned from this UI; every confirmation now names the verb and its
 * consequence, so success can never be mistaken for a fault.
 */
const CONFIRMATION: Record<Verb, (task: string, until?: string) => string> = {
  cancelled: (task) => `${task} cancelada.`,
  approved: (task) => `${task} aprobada — pasa a la cola de trabajo.`,
  deferred: (task, until) =>
    `${task} diferida hasta ${until ? fmtDate.format(new Date(until)) : 'nueva fecha'}.`,
};

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setToken(value);
    try {
      await fetchState();
      onDone();
    } catch (err) {
      clearToken();
      setError(err instanceof ApiError && err.status === 401
        ? 'Token incorrecto.'
        : 'No se pudo verificar (¿servidor caído?).');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="gate-screen">
      <form onSubmit={submit}>
        <h1>Flota</h1>
        <p>Pegá el token del tablero (está en <span className="mono">board-app/.env.local</span> de la máquina que lo sirve).</p>
        <label htmlFor="token">Token</label>
        <input id="token" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        {error && <p role="alert" style={{ color: 'var(--bad)' }}>{error}</p>}
        <button className="btn primary" type="submit" disabled={!value.trim() || checking}>
          {checking ? 'Verificando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [state, setState] = useState<BoardState | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('decisiones');
  const [sub, setSub] = useState<Sub>('trabajo');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const pushToast = useCallback((kind: Toast['kind'], text: string, line?: string) => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, kind, text, line }]);
    // Anything that isn't a clean success stays up longer: it is asking the
    // operator to do something about it.
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'ok' ? 8000 : 14000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchState();
      setState(s);
      setStatus('ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        setAuthed(false);
        return;
      }
      // Keep showing the last good state, but the staleness banner takes over.
      setError(e instanceof Error ? e.message : 'error');
      setStatus((prev) => (prev === 'ok' ? 'ok' : 'error'));
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    setStatus('loading');
    refresh();
    // Auto-refresh cada 15 s; pausa cuando la pestaña está oculta.
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [authed, refresh]);

  const onRule = useCallback(async (input: { task: string; verb: Verb; until?: string; note: string }) => {
    setResolving((prev) => new Set(prev).add(input.task));
    try {
      const { line, transition } = await postRuling(input);
      const moved = transition?.applied ? ` La tarea pasó a ${transition.to}.` : '';
      pushToast('ok', CONFIRMATION[input.verb](input.task, input.until) + moved, JSON.stringify(line));

      // Half-success is reported as half-success. The ruling is written first
      // and is authoritative, so a failed task write must never be dressed up
      // as a clean confirmation — nor as a total failure, because the decision
      // itself DID land and re-submitting would double-write it.
      if (transition && !transition.applied && transition.error) {
        pushToast('warn',
          `Ojo: la decisión de ${input.task} quedó registrada, pero la tarea NO se movió (${transition.error}). `
          + 'No la vuelvas a mandar: avisale al orquestador para que la mueva.');
      }

      // The other half-success: the task moved but the gate survived, so the
      // card stays on the board. Silence here would look exactly like the
      // T-0143 defect returning, and the operator would reasonably re-approve
      // and double-write the ruling.
      if (transition?.still_gated) {
        pushToast('warn',
          `Ojo: ${input.task} pasó a ${transition.to}, pero quedó gateada y la tarjeta sigue acá. `
          + 'No la vuelvas a aprobar: avisale al orquestador.');
      }
      await refresh();
    } catch (e) {
      pushToast('bad', `No se pudo registrar la decisión de ${input.task}: ${e instanceof Error ? e.message : 'error'}`);
      throw e;
    } finally {
      setResolving((prev) => { const next = new Set(prev); next.delete(input.task); return next; });
    }
  }, [pushToast, refresh]);

  const onNote = useCallback(async (text: string) => {
    try {
      await postInbox({ kind: 'note', text });
      pushToast('ok', 'Nota enviada al orquestador.');
    } catch (e) {
      pushToast('bad', `La nota no salió: ${e instanceof Error ? e.message : 'error'}`);
      throw e;
    }
  }, [pushToast]);

  if (!authed) return <TokenGate onDone={() => { setAuthed(true); }} />;

  const dataAgeMins = state ? ageMinutes(state.generated_at) : null;
  const stale = dataAgeMins !== null && dataAgeMins > 2;

  // El número tiene que ser lo que se ve: tarjetas gateadas + hallazgos SIN
  // DECIDIR (los que ponen el gate en rojo). Contar solo las primeras hacía
  // leer "Decisiones 2" sobre una pantalla con 20+ cartas (2026-09-02, 2ª vez).
  const unruledCount = (state?.findings_list || []).filter((f) => f.unruled).length;
  const toDecide = (state?.decisions.length || 0) + unruledCount;
  const zones: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'decisiones', label: 'Decisiones', badge: toDecide },
    { key: 'flota', label: 'Flota' },
    { key: 'actividad', label: 'Actividad' },
  ];

  return (
    <div className="app">
      <TopBar state={state} />
      {stale && (
        <div className={`stale-banner${dataAgeMins! > 10 ? '' : ' warn'}`} role="alert">
          DATOS VIEJOS: lo que ves es de hace {Math.round(dataAgeMins!)} min ({error || 'el refresco está fallando'}).
        </div>
      )}

      <main className="zones">
        <section className={`zone${tab === 'decisiones' ? ' active' : ''}`} aria-label="Decisiones">
          <h2>
            Decisiones{' '}
            <span className="n">
              {state ? `${state.decisions.length} gateada${state.decisions.length === 1 ? '' : 's'}${unruledCount ? ` + ${unruledCount} sin decidir` : ''}` : '…'}
            </span>
          </h2>
          {status === 'loading' && <Skeletons n={3} />}
          {status === 'error' && <ErrorBox message={error} onRetry={() => { setStatus('loading'); refresh(); }} />}
          {status === 'ok' && state && (
            <Decisions
              decisions={state.decisions}
              findings={state.findings_list || []}
              deferred={state.deferred_hidden || []}
              lastRuling={state.last_ruling}
              onRule={onRule}
              onNote={onNote}
              resolving={resolving}
            />
          )}
        </section>

        <section className={`zone${tab === 'flota' ? ' active' : ''}`} aria-label="Flota">
          <h2>
            Flota
            <span className="n">{state ? `${state.open_count} abiertas` : '…'}</span>
          </h2>
          <div className="segmented" role="tablist" aria-label="Vista de la flota">
            {SUBS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={sub === s.key}
                onClick={() => setSub(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {status === 'loading' && <Skeletons n={4} short />}
          {status === 'error' && <ErrorBox message={error} onRetry={() => { setStatus('loading'); refresh(); }} />}
          {status === 'ok' && state && sub === 'trabajo' && <Fleet state={state} />}
          {status === 'ok' && state && sub !== 'trabajo' && (
            state.observability
              ? (sub === 'motor' ? <Motor o={state.observability} /> : <Bots o={state.observability} />)
              : (
                // An OLD server that predates this block. Saying so is the only
                // honest option: an empty panel would read as "nothing is
                // happening" when the truth is "nobody asked".
                <ErrorBox message="este servidor todavía no envía los datos del motor (reiniciá el tablero)" />
              )
          )}
        </section>

        <section className={`zone${tab === 'actividad' ? ' active' : ''}`} aria-label="Actividad">
          <h2>Actividad</h2>
          {status === 'ok' && state?.observability && <Actions o={state.observability} />}
          <Activity />
        </section>
      </main>

      <nav className="tabs-nav" aria-label="Secciones">
        {zones.map((z) => (
          <button key={z.key} type="button" aria-selected={tab === z.key} onClick={() => setTab(z.key)}>
            <span>{z.label}</span>
            {z.badge ? <span className="badge">{z.badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
            {t.line && <span className="line">{t.line}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
