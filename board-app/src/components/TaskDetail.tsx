// The panel that answers "what does this need next?" (T-0143 D3).
//
// The operator's words about the old rows: "T-0008 ready Oversight: whatsappbot
// self-driving wave program (round 8+) actually gives me 0 insight of what it
// needs, what's the issue, what needs to be decided... nothing." Every field
// below already existed in the task file; the board simply never showed it.
//
// The adjacent failure is the opposite one, and it is the likelier one: dumping
// fourteen fields is not insight either, it is a wall. So this panel is ORDERED
// BY THE QUESTION, not by the shape of the JSON:
//
//   1. WHAT IT NEEDS   the blocker if there is one, else the next action. This
//                      is the answer, so it is first, largest, and never
//                      abbreviated. A task with neither says so loudly, because
//                      that absence is itself the finding.
//   2. why it exists   the goal, quieter, as supporting context.
//   3. how we'd know   acceptance criteria — how he judges it done.
//   4. a three-item strip: owner, repo, age. The only metadata that changes a
//      decision at a glance.
//   5. everything else folded behind "más". corr ids, attempt counts, contract
//      mode and context refs are real, occasionally needed, and noise 95% of
//      the time. Hiding them is the design choice; deleting them would not be.
//
// Deliberately NOT a card and NOT a modal: it expands in place under the row it
// belongs to. A card inside a card is nesting elevation that means nothing, and
// a modal over a decision card would be a modal over a modal.
//
// Long text WRAPS. It is never clamped — a truncated blocker is the same defect
// as no blocker.

import type { TaskDetail as Detail } from '../types';
import { ageText, fmtDate } from '../format';

const when = (isoStr: string | null) =>
  (isoStr && Number.isFinite(Date.parse(isoStr)) ? fmtDate.format(new Date(isoStr)) : '—');

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tmeta">
      <span className="k">{label}</span>
      <span className="v mono">{children}</span>
    </div>
  );
}

/**
 * `shown` is text the caller has ALREADY put on screen above this panel — the
 * decision card renders the blocker as the question the operator is answering.
 * Repeating it verbatim two inches lower is the field-wall failure this panel
 * was ordered to avoid, so an identical lead is dropped rather than echoed.
 */
export default function TaskDetail({ d, id, shown = '' }: { d: Detail; id: string; shown?: string }) {
  // Leases expire. An expired lease means the task is reclaimable, not owned,
  // and the panel must not imply somebody is on it.
  const leaseExpired = Boolean(d.lease?.expires_at && Date.parse(d.lease.expires_at) < Date.now());
  const owner = d.lease?.owner ? `${d.lease.owner}${leaseExpired ? ' · lease vencido' : ''}` : 'sin dueño';

  // The lead. Blocker outranks next_action: if something is in the way, that is
  // what it needs, whatever the plan said.
  const need = d.blocker || d.next_action || '';
  const needLabel = d.blocker ? 'Está trabado por' : 'Qué necesita ahora';
  const echoed = Boolean(need) && need.trim() === shown.trim();

  const hasExtras = Boolean(
    d.depends_on.length || d.context_refs.length || d.corr || d.kind || d.attempt || d.contract_mode,
  );

  return (
    <div className="tdetail">
      {!echoed && (
        <section className={`tneed${d.blocker ? ' blocked' : ''}`}>
          <div className="k">{needLabel}</div>
          {need
            ? <p className="prose lead">{need}</p>
            : <p className="prose none">Nadie escribió qué sigue. Eso ya es la respuesta: esta tarea no tiene próximo paso.</p>}
        </section>
      )}

      {d.goal && (
        <section>
          <div className="k">Para qué existe</div>
          <p className="prose">{d.goal}</p>
        </section>
      )}

      {d.acceptance_criteria.length > 0 && (
        <section>
          <div className="k">Cómo se sabe que terminó · {d.acceptance_criteria.length}</div>
          <ol className="crit">
            {d.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}
          </ol>
        </section>
      )}

      <div className="tstrip">
        <Meta label="dueño">{owner}</Meta>
        <Meta label="repo">{d.repo || '—'}</Meta>
        <Meta label="tocada">{ageText(d.updated_at)}</Meta>
      </div>

      {hasExtras && (
        <details className="tmore">
          <summary>más</summary>
          <div className="tmore-body">
            {d.depends_on.length > 0 && <Meta label="depende de">{d.depends_on.join(', ')}</Meta>}
            {d.corr && <Meta label="corr">{d.corr}</Meta>}
            {d.kind && <Meta label="tipo">{d.kind}</Meta>}
            {d.contract_mode && <Meta label="contrato">{d.contract_mode}</Meta>}
            {d.attempt ? <Meta label="intento">{d.attempt}</Meta> : null}
            <Meta label="creada">{when(d.created_at)}</Meta>
            {d.context_refs.length > 0 && (
              <ul className="refs">
                {d.context_refs.map((r) => <li key={r} className="mono">{r}</li>)}
              </ul>
            )}
            <div className="tdetail-src">{`_intel/tasks/${id}.json`}</div>
          </div>
        </details>
      )}
    </div>
  );
}
