import type { Observability } from '../types';
import { ageText, fmtDate } from '../format';
import { EmptyBox, SourcePanel } from './bits';
import Markdown from './Markdown';

/**
 * BOTS — the local Hermes bots that watch the fleet without spending a token.
 *
 * Two halves. The BRIEFS are what the bots wrote (the centinela's control-plane
 * alerts and the zero-token fleet sensor). The CRON is whether the thing that
 * writes them is still alive — because a brief that stopped updating looks
 * exactly like a brief with nothing to report, and only the ticker can tell
 * those apart.
 */

function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? fmtDate.format(new Date(t)) : '—';
}

function Briefs({ o }: { o: Observability }) {
  const b = o.briefs;
  const items = b.items || [];
  return (
    <SourcePanel title="Lo que escribieron los bots" source={b} count={items.filter((i) => !i.missing).length || null}>
      {items.length ? items.map((i) => (
        <div key={i.key} className="brief">
          <h4>
            {i.label}
            <span className="src-age">
              {i.missing ? 'sin novedades' : `última corrida ${ageText(i.last_run_at)}`}
            </span>
          </h4>
          {i.missing ? (
            <EmptyBox title="Nada que reportar.">
              Este archivo sólo aparece cuando algo anda mal. Que no exista es buena noticia.
            </EmptyBox>
          ) : (
            <>
              <Markdown text={i.text || ''} />
              {i.truncated && <p className="hint">Recortado. El archivo completo está en {i.file}.</p>}
            </>
          )}
        </div>
      )) : (
        <EmptyBox title="Ningún bot escribió todavía." />
      )}
    </SourcePanel>
  );
}

function Cron({ o }: { o: Observability }) {
  const h = o.hermes_cron;
  const jobs = h.jobs || [];
  const runs = h.runs || [];
  return (
    <SourcePanel
      title="Ticker de los bots"
      source={h}
      count={jobs.length || null}
      hint="Cada cuánto corre cada bot y si la última corrida salió bien. Si esto se para, los informes de arriba se congelan sin avisar."
    >
      {jobs.length ? (
        <table>
          <thead>
            <tr><th>bot</th><th>cada</th><th>última</th><th>próxima</th><th>estado</th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const bad = j.last_status !== 'ok' || j.failure_streak > 0;
              return (
                <tr key={j.id} className={bad ? 'row-warn' : undefined}>
                  <td>{j.name}</td>
                  <td className="num dim">{j.schedule}</td>
                  <td className="num dim">{ageText(j.last_run_at)}</td>
                  <td className="num dim">{fmtLocal(j.next_run_at)}</td>
                  <td>
                    <span className={`tag ${bad ? 'warn' : 'ok'}`}>
                      {j.enabled ? (j.last_status || j.state) : 'apagado'}
                    </span>
                    {j.failure_streak > 0 && <span className="note">{j.failure_streak} fallas seguidas</span>}
                    {j.last_error && <span className="note">{j.last_error}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyBox title="No hay bots programados." />
      )}

      {runs.length > 0 && (
        <>
          <p className="hint">Últimas {runs.length} corridas:</p>
          <table>
            <thead>
              <tr><th>arrancó</th><th>terminó</th><th>estado</th></tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i} className={r.status !== 'completed' ? 'row-warn' : undefined}>
                  <td className="num dim">{fmtLocal(r.started_at)}</td>
                  <td className="num dim">{fmtLocal(r.finished_at)}</td>
                  <td>
                    <span className={`tag ${r.status === 'completed' ? 'ok' : 'warn'}`}>{r.status}</span>
                    {r.error && <span className="note">{r.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {h.runs === null && h.runs_error && (
        <p className="hint">
          No se pudo leer el historial de corridas ({h.runs_error}). Para verlo a mano:{' '}
          <code className="mono">{h.runs_hint}</code>.
        </p>
      )}
    </SourcePanel>
  );
}

export default function Bots({ o }: { o: Observability }) {
  return (
    <>
      <Briefs o={o} />
      <Cron o={o} />
    </>
  );
}
