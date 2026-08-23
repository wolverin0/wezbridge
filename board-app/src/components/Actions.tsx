import { useMemo, useState } from 'react';
import type { Observability } from '../types';
import { fmtDate } from '../format';
import { EmptyBox, SourcePanel } from './bits';

/**
 * ACCIONES FIRMADAS — "quién hizo qué y por qué", the thing the operator asked
 * to have in front of him rather than to go looking for.
 *
 * It sits at the TOP of the ACTIVIDAD zone on purpose: on the desktop that
 * column is always on screen, so the answer to "¿quién tocó esto?" never costs
 * a click. Every row is passed through exactly as the actor signed it — this is
 * a window onto actions.jsonl, never a paraphrase of it.
 *
 * Local time, always. The log is UTC and the operator is not.
 */

const WHY_CAP = 140;

export default function Actions({ o }: { o: Observability }) {
  const a = o.actions;
  const items = useMemo(() => a.items || [], [a.items]);
  const [actor, setActor] = useState('todos');
  const [expanded, setExpanded] = useState<number | null>(null);

  const actors = useMemo(
    () => ['todos', ...Array.from(new Set(items.map((i) => i.actor))).sort()],
    [items],
  );
  const rows = actor === 'todos' ? items : items.filter((i) => i.actor === actor);

  return (
    <SourcePanel
      title="Quién hizo qué"
      source={a}
      count={a.count || null}
      hint="Cada cosa que la flota hizo sola, firmada por quien la hizo. Las últimas primero."
    >
      {items.length ? (
        <>
          {actors.length > 2 && (
            <div className="filter-row">
              <select aria-label="Filtrar por quién" value={actor} onChange={(e) => setActor(e.target.value)}>
                {actors.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          )}
          <table className="actions-tbl">
            <thead>
              <tr><th>hora</th><th>quién</th><th>qué</th><th>sobre qué</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const t = r.at ? Date.parse(r.at) : NaN;
                const long = r.why.length > WHY_CAP || Boolean(r.extra);
                const open = expanded === i;
                return (
                  <tr
                    key={`${r.at}-${i}`}
                    className={long ? `act-row${open ? ' open' : ''}` : undefined}
                    onClick={long ? () => setExpanded(open ? null : i) : undefined}
                    tabIndex={long ? 0 : undefined}
                    role={long ? 'button' : undefined}
                    aria-expanded={long ? open : undefined}
                    onKeyDown={long ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(open ? null : i); }
                    } : undefined}
                  >
                    <td className="num dim">{Number.isFinite(t) ? fmtDate.format(new Date(t)) : '—'}</td>
                    <td className="mono">{r.actor}</td>
                    <td>
                      <span className="tag neutral">{r.action}</span>
                      <span className="why">
                        {open || r.why.length <= WHY_CAP ? r.why : `${r.why.slice(0, WHY_CAP)}…`}
                      </span>
                      {open && r.extra && <span className="note mono">{r.extra}</span>}
                    </td>
                    <td className="mono dim">{r.target || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyBox title={`${actor} no hizo nada en esta ventana.`} />
          )}
        </>
      ) : (
        <EmptyBox title="La flota no hizo nada todavía.">
          Acá aparece cada acción automática apenas ocurra.
        </EmptyBox>
      )}
    </SourcePanel>
  );
}
