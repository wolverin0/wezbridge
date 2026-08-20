import { useEffect, useState } from 'react';
import type { BoardState } from '../types';
import { ageMinutes, ageText, fmtClock } from '../format';

/**
 * Honesty rules of the top bar: a pill only goes green on positive evidence.
 * Missing file, unreadable state or old data render amber/red UNKNOWN/STALE —
 * never a calm default.
 */
function pillClass(mins: number | null, warnAfter: number, badAfter: number): string {
  if (mins === null) return 'bad';
  if (mins > badAfter) return 'bad';
  if (mins > warnAfter) return 'warn';
  return 'ok';
}

export default function TopBar({ state }: { state: BoardState | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const gate = state?.gate;
  const gateClass = !gate ? 'warn' : gate.verdict === 'GREEN' ? 'ok' : 'bad';
  const gateLabel = !gate
    ? 'gate: DESCONOCIDO'
    : `gate: ${gate.verdict}${gate.unruled ? ` (${gate.unruled} sin decidir)` : ''}`;

  // Freshness (slice 4): stale work evidence with untouched open tasks.
  // UNKNOWN renders amber, never a calm green — same honesty rule as the rest.
  const fresh = state?.freshness;
  const freshClass = !fresh || fresh.verdict === 'UNKNOWN' ? 'warn' : fresh.verdict === 'GREEN' ? 'ok' : 'bad';
  const freshLabel = !fresh || fresh.verdict === 'UNKNOWN'
    ? 'frescura: DESCONOCIDA'
    : fresh.verdict === 'RED'
      ? `frescura: RED (${fresh.stale.map((s) => s.repo).join(', ')})`
      : 'frescura: GREEN';

  const turnMins = state ? ageMinutes(state.last_turn_at) : null;
  const snapMins = state ? ageMinutes(state.snapshot_at) : null;

  return (
    <header className="topbar">
      <span className="brand">Flota</span>
      <span className={`pill ${gateClass}`}>{gateLabel}</span>
      <span className={`pill ${freshClass}`} title={fresh?.stale.map((s) => `${s.repo} ${s.sha ?? s.evidence_kind} hace ${s.age_hours}h sin tarea tocada`).join('\n') || undefined}>
        {freshLabel}
      </span>
      <span className={`pill ${pillClass(turnMins, 150, 300)}`}>
        turno: {state ? ageText(state.last_turn_at) : '…'}
      </span>
      <span className={`pill ${pillClass(snapMins, 5, 30)}`}>
        snapshot: {state ? ageText(state.snapshot_at) : '…'}
      </span>
      <span className={`pill ${state?.kitchen?.status === 'up' ? 'ok' : state?.kitchen?.status === 'down' ? 'bad' : ''}`}>
        cocina: {state?.kitchen?.status === 'up' ? 'OK' : state?.kitchen?.status === 'down' ? 'CAÍDA' : 'sin configurar'}
      </span>
      <span className="clock num" aria-label="hora actual">{fmtClock.format(now)}</span>
    </header>
  );
}
