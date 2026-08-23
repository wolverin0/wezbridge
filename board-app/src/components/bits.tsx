// Small shared pieces: the four panel states live here so every zone
// renders loading / error / empty / success the same way.

import { ageText } from '../format';

export function Skeletons({ n = 3, short = false }: { n?: number; short?: boolean }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`skeleton${short ? ' short' : ''}`} />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <div>No se pudo leer el estado: {message}</div>
      {onRetry && (
        <button className="btn" onClick={onRetry} type="button">
          Reintentar
        </button>
      )}
    </div>
  );
}

export function EmptyBox({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function StateTag({ state }: { state: string }) {
  return <span className={`state-tag ${state}`}>{state}</span>;
}

/**
 * One observability panel = one source = one age = one failure.
 *
 * Every panel below the fold reads a DIFFERENT file, so each one gets its own
 * header stamp and its own error. Six panels under one page-level timestamp is
 * the calm lie this fleet keeps re-finding: five fresh sources vouching for a
 * dead sixth. If a source blew up, its panel says so and the rest keep working.
 */
export function SourcePanel({ title, count, source, hint, children }: {
  title: string;
  count?: number | string | null;
  source?: { generated_at?: string; error?: string } | null;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="section">
      <h3>
        {title}
        {count !== undefined && count !== null && <span className="count">{count}</span>}
        {source?.generated_at && <span className="src-age">leído {ageText(source.generated_at)}</span>}
      </h3>
      {hint && <p className="hint">{hint}</p>}
      {source?.error
        ? <div className="error-box" role="alert">No se pudo leer esta fuente: {source.error}</div>
        : children}
    </div>
  );
}

/**
 * A labelled proportional bar. The BAR carries the colour, the number stays in
 * ink: a count painted red reads as "this number is wrong" rather than "this
 * category is serious", and every row is named in words so the meaning never
 * depends on colour alone.
 */
export function Bar({ label, sub, value, max, tone }: {
  label: string;
  sub?: string;
  value: number;
  max: number;
  tone: 'ok' | 'warn' | 'bad' | 'mute';
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <div className="bar-label">
        <b>{label}</b>
        {sub && <span>{sub}</span>}
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${tone}`} style={{ width: `${value > 0 ? Math.max(pct, 2) : 0}%` }} />
      </div>
      <span className="num bar-value">{value}</span>
    </div>
  );
}
