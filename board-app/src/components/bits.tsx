// Small shared pieces: the four panel states live here so every zone
// renders loading / error / empty / success the same way.

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
