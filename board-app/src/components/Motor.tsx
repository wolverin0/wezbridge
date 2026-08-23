import { useState } from 'react';
import type { CensusItem, Observability, WakeClass } from '../types';
import { ageText, fmtDate } from '../format';
import { Bar, EmptyBox, SourcePanel } from './bits';
import Markdown from './Markdown';

/**
 * MOTOR — what the orchestration engine itself did, as opposed to FLOTA, which
 * is what the WORK is doing. Four sources, four independent panels: the daily
 * rollup, the waker's turns, the per-project queues, and the Windows scheduled
 * tasks that actually run all of it.
 *
 * The operator is not an engineer. Every class name the machinery uses is shown
 * WITH its meaning in plain Spanish, and nothing here is encoded in colour
 * alone.
 */

/**
 * The four wake classes, in the order a human should read them: productive
 * first, broken last. Colour is the design system's reserved STATUS ramp, which
 * is legitimate here because these genuinely are states, not an arbitrary
 * series — and each one still carries its label.
 */
const WAKE_LABELS: Record<WakeClass, { es: string; tone: 'ok' | 'warn' | 'bad' | 'mute' }> = {
  'results-directed': { es: 'Trabajo terminado esperando que alguien lo juzgue', tone: 'ok' },
  'real-stall': { es: 'Trabajo vencido sin decisión (el gate en rojo)', tone: 'warn' },
  exception: { es: 'Se rompió algo de la maquinaria', tone: 'bad' },
  noise: { es: 'Ruido: se miró y no despertó a nadie', tone: 'mute' },
};

const CENSUS_LABELS: Record<CensusItem['class'], string> = {
  ok: 'ok',
  'silent-failure': 'FALLA SILENCIOSA',
  'contract-signal': 'señal esperada',
  'never-ran': 'nunca corrió',
  running: 'corriendo',
  disabled: 'deshabilitada',
};

/**
 * Rewrites the UTC stamps inside a machine-written file to the operator's local
 * time.
 *
 * This is not cosmetic. The rollup filename is a LOCAL date and every timestamp
 * in its body is UTC, so a file called `2026-08-22.md` opens with
 * "Generado 2026-08-23T03:23Z" and the operator has concluded more than once
 * that he was reading tomorrow's report. The panel labels the conversion so the
 * screen never silently disagrees with the file on disk.
 */
function localizeUtc(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/g, (m) => {
    const t = Date.parse(m);
    return Number.isFinite(t) ? `${fmtDate.format(new Date(t))} (local)` : m;
  });
}

function Rollup({ o }: { o: Observability }) {
  const r = o.rollup;
  const [open, setOpen] = useState(false);
  return (
    <SourcePanel title="Rollup del día" source={r} count={r.newest_date || null}>
      {r.ran === false && (
        <div className="notice warn" role="status">
          Hoy todavía no corrió. Corre a las {r.next_run_local} de la mañana, hora tuya, y cierra
          el día {r.expected}. {r.newest_date
            ? `Lo último que hay es el ${r.newest_date}.`
            : 'Todavía no hay ningún rollup.'}
        </div>
      )}
      {r.text ? (
        <>
          <p className="hint">
            Cubre el día {r.newest_date} (tu día, no UTC). Archivo escrito {ageText(r.file_at ?? null)}.
            Las horas de adentro vienen en UTC y acá se muestran ya convertidas a tu hora.
          </p>
          <div className={`md-wrap${open ? ' open' : ''}`}>
            <Markdown text={localizeUtc(r.text)} />
          </div>
          <button type="button" className="btn ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Ver menos' : 'Ver todo el rollup'}
          </button>
        </>
      ) : (
        <EmptyBox title="Todavía no hay ningún rollup escrito.">
          El primero aparece después de la corrida de las {r.next_run_local}.
        </EmptyBox>
      )}
    </SourcePanel>
  );
}

function Waker({ o }: { o: Observability }) {
  const w = o.waker;
  const classes = w.classes || ({} as Record<WakeClass, number>);
  const total = w.total || 0;
  const max = Math.max(1, ...Object.values(classes));
  const ageMin = w.last_turn_age_minutes;
  // Turns run roughly every two hours; a whole day of silence means the loop
  // stopped, which is exactly the death nobody notices.
  const quiet = ageMin !== null && ageMin !== undefined && ageMin > 240;

  return (
    <SourcePanel
      title="Motor de turnos"
      source={w}
      count={total ? `${total} turnos` : null}
      hint="Cada tanto el motor mira la flota y decide si hace falta despertar a alguien. Mirar es gratis; despertar cuesta."
    >
      {total ? (
        <>
          <div className="kpis">
            <div>
              <b className="num">{w.woke ?? 0}</b>
              <span>despertó a alguien</span>
            </div>
            <div>
              <b className="num">{w.skipped ?? 0}</b>
              <span>miró y no hizo falta (gratis)</span>
            </div>
            <div>
              <b className={`num${quiet ? ' bad' : ''}`}>{ageMin === null || ageMin === undefined ? '?' : ageText(w.last_turn_at ?? null)}</b>
              <span>{quiet ? 'ÚLTIMO TURNO: hace demasiado' : 'último turno'}</span>
            </div>
          </div>

          <div className="bars">
            {(Object.keys(WAKE_LABELS) as WakeClass[]).map((c) => (
              <Bar
                key={c}
                label={WAKE_LABELS[c].es}
                sub={c}
                value={classes[c] || 0}
                max={max}
                tone={WAKE_LABELS[c].tone}
              />
            ))}
          </div>

          {w.last_reasons && w.last_reasons.length > 0 && (
            <>
              <p className="hint">Por qué se movió la última vez:</p>
              <ul className="reasons">
                {w.last_reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
        </>
      ) : (
        <EmptyBox title="El motor todavía no registró ningún turno." />
      )}
    </SourcePanel>
  );
}

function Queues({ o }: { o: Observability }) {
  const q = o.queues;
  const projects = q.projects || [];
  return (
    <SourcePanel
      title="Colas por proyecto"
      source={q}
      count={projects.length || null}
      hint="Mensajes que el motor le mandó a cada proyecto. Un mensaje que no salió es trabajo que nadie recibió."
    >
      {projects.length ? (
        <>
          <table>
            <thead>
              <tr>
                <th>proyecto</th><th>total</th><th>salieron</th><th>sin salir</th><th>el más viejo</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const stuck = (p.undelivered || 0) > 0;
                const oldMin = p.oldest_undelivered_minutes ?? null;
                return (
                  <tr key={p.project} className={stuck ? 'row-warn' : undefined}>
                    <td>{p.project}</td>
                    <td className="num dim">{p.error ? '?' : p.total}</td>
                    <td className="num dim">{p.error ? '?' : p.delivered}</td>
                    <td className="num">
                      {p.error ? '?' : p.undelivered}
                      {stuck && <span className="tag warn">ATASCADA</span>}
                    </td>
                    <td className="num dim">
                      {oldMin === null ? '—' : ageText(p.oldest_undelivered_at ?? null)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            Banderas del motor: {q.flags ?? '?'} · pendientes: {q.pending ?? '?'}
          </p>
        </>
      ) : (
        <EmptyBox title="Ninguna cola tiene actividad.">
          Es la situación normal: todo lo que se mandó, llegó.
        </EmptyBox>
      )}
    </SourcePanel>
  );
}

function Census({ o }: { o: Observability }) {
  const c = o.census;
  const [showAll, setShowAll] = useState(false);
  const silent = c.silent || [];
  const items = c.items || [];
  const shown = showAll ? items : items.filter((i) => i.class !== 'ok');

  if (c.status === 'pending') {
    return (
      <SourcePanel title="Tareas programadas de Windows" source={{ generated_at: undefined }}>
        <div className="skeleton" aria-label="Leyendo el Programador de tareas" />
        <p className="hint">Leyendo el Programador de tareas. Aparece en el próximo refresco.</p>
      </SourcePanel>
    );
  }

  return (
    <SourcePanel
      title="Tareas programadas de Windows"
      source={{ generated_at: c.generated_at || undefined, error: c.status === 'error' ? c.error : undefined }}
      count={items.length || null}
      hint="Lo que Windows corre solo. Si una termina mal y nadie mira, el trabajo deja de hacerse sin que nada avise."
    >
      {items.length ? (
        <>
          {silent.length > 0 && (
            <div className="notice bad" role="alert">
              {silent.length === 1 ? 'Una tarea está fallando' : `${silent.length} tareas están fallando`} sin
              que nada avise: {silent.map((s) => s.name).join(', ')}.
            </div>
          )}
          <table>
            <thead>
              <tr><th>tarea</th><th>última</th><th>salida</th><th>estado</th></tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.name} className={i.class === 'silent-failure' ? 'row-bad' : undefined}>
                  <td>{i.name}</td>
                  <td className="num dim">{i.lastRun}</td>
                  <td className="num dim">{i.lastResult}</td>
                  <td>
                    <span className={`tag census-${i.class}`}>{CENSUS_LABELS[i.class] || i.class}</span>
                    {i.note && <span className="note">{i.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll
              ? 'Mostrar sólo las que piden atención'
              : `Ver las ${items.length} tareas (${items.length - shown.length} en orden)`}
          </button>
        </>
      ) : (
        <EmptyBox title="No se leyó ninguna tarea programada.">
          {c.status === 'error' ? 'El Programador de tareas no respondió.' : 'Ninguna tarea de la flota está registrada.'}
        </EmptyBox>
      )}
    </SourcePanel>
  );
}

export default function Motor({ o }: { o: Observability }) {
  return (
    <>
      <Rollup o={o} />
      <Waker o={o} />
      <Queues o={o} />
      <Census o={o} />
    </>
  );
}
