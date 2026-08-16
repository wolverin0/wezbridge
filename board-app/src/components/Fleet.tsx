import { useMemo, useState } from 'react';
import type { BoardState, TaskDetail as Detail } from '../types';
import { ageText } from '../format';
import { EmptyBox, StateTag } from './bits';
import TaskDetail from './TaskDetail';

/**
 * A task row that opens in place (T-0143 D3). Click expands; no navigation, no
 * modal. The whole row is the target — a 44px hit area the operator can reach
 * with a thumb on the phone, which is where he reads these.
 */
function TaskRow({ id, detail, cols, children }: {
  id: string;
  detail: Detail;
  cols: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className={`task-row${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`detail-${id}`}
        tabIndex={0}
        role="button"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
        }}
      >
        {children}
      </tr>
      {open && (
        <tr className="task-row-detail" id={`detail-${id}`}>
          <td colSpan={cols}><TaskDetail d={detail} id={id} /></td>
        </tr>
      )}
    </>
  );
}

function Sparkline({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  const pts = buckets.map((v, i) => `${(i / (buckets.length - 1)) * 100},${40 - (v / max) * 36}`);
  const area = `0,40 ${pts.join(' ')} 100,40`;
  return (
    <div className="spark" role="img" aria-label={`Actividad de las últimas 24 horas, pico de ${max} eventos por hora`}>
      <span>24 h</span>
      <svg viewBox="0 0 100 44" preserveAspectRatio="none">
        <polygon className="area" points={area} />
        <polyline points={pts.join(' ')} />
      </svg>
      <span className="num">máx {max}/h</span>
    </div>
  );
}

const STATES = ['todos', 'ready', 'queued', 'running', 'review', 'blocked', 'failed'];

export default function Fleet({ state }: { state: BoardState }) {
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('todos');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.entries(state.by_repo)
      .map(([repo, tasks]) => [
        repo,
        tasks.filter((t) =>
          (stateFilter === 'todos' || t.state === stateFilter) &&
          // Search reaches the goal too: the row's title was never enough to
          // find a task by, which is the same complaint as D3.
          (!needle || `${t.id} ${t.title} ${repo} ${t.detail?.goal || ''}`.toLowerCase().includes(needle))
        ),
      ] as const)
      .filter(([, tasks]) => tasks.length)
      .sort((a, b) => b[1].length - a[1].length);
  }, [state.by_repo, q, stateFilter]);

  return (
    <>
      <div className="section">
        <Sparkline buckets={state.sparkline} />
      </div>

      <div className="section">
        <h3>En vuelo · {state.in_flight.length}</h3>
        {state.in_flight.length ? (
          <table>
            <thead>
              <tr><th>id</th><th>estado</th><th>dueño</th><th>título</th><th>quieto</th></tr>
            </thead>
            <tbody>
              {state.in_flight.map((t) => (
                <TaskRow key={t.id} id={t.id} detail={t.detail} cols={5}>
                  <td className="mono">{t.id}</td>
                  <td><StateTag state={t.state} /></td>
                  <td className="mono dim">{t.owner || '—'}</td>
                  <td>{t.title}</td>
                  <td className="mono dim">{ageText(t.updated_at)}</td>
                </TaskRow>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyBox title="Nada en ejecución ahora." />
        )}
      </div>

      <div className="section">
        <h3>Rutinas · {state.routines.length}</h3>
        {state.routines.length ? (
          <table>
            <thead>
              <tr><th>rutina</th><th>repo</th><th>corrió</th><th>veredicto</th><th>próxima</th></tr>
            </thead>
            <tbody>
              {state.routines.map((r) => {
                const cadence = r.cadence_hours > 0 ? r.cadence_hours : 168;
                const due = r.at + cadence * 3600000;
                const overdue = Date.now() > due + 24 * 3600000;
                return (
                  <tr key={`${r.routine}-${r.at}`}>
                    <td>{r.routine}</td>
                    <td className="mono dim">{r.repo}</td>
                    <td className="mono dim">{ageText(r.at)}</td>
                    <td style={{ color: r.verdict === 'clean' ? 'var(--ok)' : 'var(--warn)' }}>{r.verdict}</td>
                    <td className="mono" style={overdue ? { color: 'var(--bad)' } : undefined}>
                      {overdue ? 'VENCIDA' : new Date(due).toLocaleDateString('es-AR')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyBox title="Ninguna rutina corrió todavía." />
        )}
      </div>

      <div className="section">
        <h3>Trabajo abierto por proyecto</h3>
        <div className="filter-row">
          <input
            type="search"
            placeholder="Buscar tarea…"
            aria-label="Buscar tarea"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select aria-label="Filtrar por estado" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {groups.length ? groups.map(([repo, tasks]) => (
          <details key={repo} className="repo-group" open={groups.length <= 3}>
            <summary><b>{repo}</b> <span className="count">{tasks.length}</span></summary>
            <table>
              <tbody>
                {tasks.map((t) => (
                  <TaskRow key={t.id} id={t.id} detail={t.detail} cols={4}>
                    <td className="mono">{t.id}</td>
                    <td><StateTag state={t.state} /></td>
                    <td>{t.title}</td>
                    <td className="mono dim">{ageText(t.updated_at)}</td>
                  </TaskRow>
                ))}
              </tbody>
            </table>
          </details>
        )) : (
          <EmptyBox title="Sin resultados.">Probá con otro término o filtro.</EmptyBox>
        )}
      </div>
    </>
  );
}
