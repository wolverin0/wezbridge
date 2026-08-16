import { useState } from 'react';
import type { Decision, Finding, RulingLine, Verb } from '../types';
import { ageText, fmtDate } from '../format';
import { EmptyBox } from './bits';

interface Props {
  decisions: Decision[];
  findings: Finding[];
  lastRuling: RulingLine | null;
  onRule: (input: { task: string; verb: Verb; until?: string; note: string }) => Promise<void>;
  onNote: (text: string) => Promise<void>;
  resolving: Set<string>;
}

const DEFER_OPTIONS: Array<{ label: string; days: number }> = [
  { label: '1 día', days: 1 },
  { label: '1 semana', days: 7 },
  { label: '1 mes', days: 30 },
];

function DecisionCard({ d, onRule, onNote, busy }: {
  d: Decision;
  onRule: Props['onRule'];
  onNote: Props['onNote'];
  busy: boolean;
}) {
  const [deferOpen, setDeferOpen] = useState(false);
  const [composer, setComposer] = useState<null | { verb: Verb | 'nota'; until?: string }>(null);
  const [note, setNote] = useState('');
  const [customDate, setCustomDate] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!composer || !note.trim()) return;
    setSending(true);
    try {
      if (composer.verb === 'nota') {
        await onNote(`[${d.id}] ${note.trim()}`);
      } else {
        await onRule({ task: d.id, verb: composer.verb, until: composer.until, note: note.trim() });
      }
      setComposer(null);
      setNote('');
    } finally {
      setSending(false);
    }
  };

  const openComposer = (verb: Verb | 'nota', until?: string) => {
    setDeferOpen(false);
    setComposer({ verb, until });
  };

  const composerLabel =
    composer?.verb === 'approved' ? `Aprobar ${d.id} — ¿por qué?`
    : composer?.verb === 'cancelled' ? `Cancelar ${d.id} — ¿por qué?`
    : composer?.verb === 'deferred' ? `Diferir ${d.id} hasta ${composer.until ? fmtDate.format(new Date(composer.until)) : ''} — ¿por qué?`
    : `Nota al orquestador sobre ${d.id}`;

  return (
    <article className={`decision${busy ? ' resolving' : ''}`} aria-busy={busy}>
      <header>
        <span className="id">{d.id}</span>
        <span className="repo">{d.repo}</span>
        <span className="age">{ageText(d.updated_at)}</span>
      </header>
      <div className="title">{d.title}</div>
      <div className="question">{d.question || 'Sin pregunta registrada — eso ya es un problema.'}</div>

      {!composer && (
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy} onClick={() => openComposer('approved')}>
            Aprobar
          </button>
          <div className="defer-wrap">
            <button
              className="btn"
              type="button"
              disabled={busy}
              aria-expanded={deferOpen}
              aria-haspopup="menu"
              onClick={() => setDeferOpen((v) => !v)}
            >
              Diferir ▾
            </button>
            {deferOpen && (
              <div className="defer-menu" role="menu">
                {DEFER_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    role="menuitem"
                    onClick={() => openComposer('deferred', new Date(Date.now() + o.days * 86400000).toISOString())}
                  >
                    {o.label}
                  </button>
                ))}
                <div className="custom">
                  <label htmlFor={`until-${d.id}`}>Hasta fecha y hora…</label>
                  <input
                    id={`until-${d.id}`}
                    type="datetime-local"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                  />
                  <button
                    className="btn"
                    type="button"
                    disabled={!customDate}
                    onClick={() => openComposer('deferred', new Date(customDate).toISOString())}
                  >
                    Usar fecha
                  </button>
                </div>
              </div>
            )}
          </div>
          <button className="btn danger" type="button" disabled={busy} onClick={() => openComposer('cancelled')}>
            Cancelar
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => openComposer('nota')}>
            Nota al orquestador
          </button>
        </div>
      )}

      {composer && (
        <div className="composer">
          <label htmlFor={`note-${d.id}`}>{composerLabel}</label>
          <textarea
            id={`note-${d.id}`}
            value={note}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            placeholder="El porqué queda escrito en el fallo, textual."
          />
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => { setComposer(null); setNote(''); }}>
              Volver
            </button>
            <button className="btn primary" type="button" disabled={!note.trim() || sending} onClick={submit}>
              {sending ? 'Enviando…' : 'Confirmar'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export default function Decisions({ decisions, findings, lastRuling, onRule, onNote, resolving }: Props) {
  const findingCards: Decision[] = findings.map((f) => ({
    id: f.id,
    repo: f.repo,
    title: f.title || f.id,
    state: f.category,
    updated_at: new Date(Date.now() - f.age_hours * 3600000).toISOString(),
    question: `${f.category}${f.unruled ? ' — SIN FALLO, el gate está rojo por esto' : ''}: ${f.why}`,
    category: f.category,
  }));

  return (
    <>
      {decisions.length ? (
        decisions.map((d) => (
          <DecisionCard key={d.id} d={d} onRule={onRule} onNote={onNote} busy={resolving.has(d.id)} />
        ))
      ) : (
        <>
          <EmptyBox title="Nada espera tu decisión.">
            Cero tareas abiertas con gate de operador — es un dato real, no una pantalla vacía.
          </EmptyBox>
          {lastRuling && (
            <p className="last-ruled">
              Último fallo: <span className="mono">{lastRuling.ruling}: {lastRuling.task}</span>{' '}
              {ageText(lastRuling.at)} — {lastRuling.why.slice(0, 120)}
            </p>
          )}
        </>
      )}

      {findingCards.length > 0 && (
        <section aria-label="Hallazgos del steward">
          <h3 className="findings-head">
            Hallazgos del steward · {findingCards.length}
            {findings.some((f) => f.unruled) && <span className="unruled-flag"> — hay sin fallo</span>}
          </h3>
          {findingCards.map((d) => (
            <DecisionCard key={`f-${d.id}`} d={d} onRule={onRule} onNote={onNote} busy={resolving.has(d.id)} />
          ))}
        </section>
      )}
    </>
  );
}
