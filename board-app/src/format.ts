// es-AR time helpers. Relative ages everywhere; absolute on demand.

export function ageText(iso: string | number | null): string {
  if (iso === null || iso === undefined) return 'nunca';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return 'nunca';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'recién';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

export function ageMinutes(iso: string | number | null): number | null {
  if (iso === null || iso === undefined) return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

export const fmtDate = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

export const fmtClock = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
