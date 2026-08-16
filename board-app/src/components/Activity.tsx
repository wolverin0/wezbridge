import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchActivity } from '../api';
import type { ActivityItem } from '../types';
import { ageText } from '../format';
import { EmptyBox, ErrorBox, Skeletons } from './bits';

const TYPES: Array<{ key: ActivityItem['type']; label: string }> = [
  { key: 'ruling', label: 'fallos' },
  { key: 'event', label: 'eventos' },
  { key: 'operator', label: 'operador' },
  { key: 'routine', label: 'rutinas' },
];

export default function Activity() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [error, setError] = useState('');
  const [active, setActive] = useState<Set<ActivityItem['type']>>(new Set(TYPES.map((t) => t.key)));
  const loadingMore = useRef(false);

  const load = useCallback(async (p: number, replace: boolean) => {
    try {
      const res = await fetchActivity(p);
      setItems((prev) => (replace ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      setPage(p);
      setStatus('ok');
    } catch (e) {
      if (replace) { setStatus('error'); setError(e instanceof Error ? e.message : 'error'); }
    }
  }, []);

  useEffect(() => {
    load(0, true);
    const id = setInterval(() => {
      if (!document.hidden && !loadingMore.current) load(0, true);
    }, 30000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = (key: ActivityItem['type']) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  if (status === 'loading') return <Skeletons n={6} short />;
  if (status === 'error') return <ErrorBox message={error} onRetry={() => { setStatus('loading'); load(0, true); }} />;

  const visible = items.filter((i) => active.has(i.type));

  return (
    <>
      <div className="feed-filters" role="group" aria-label="Filtrar actividad por tipo">
        {TYPES.map((t) => (
          <button key={t.key} type="button" aria-pressed={active.has(t.key)} onClick={() => toggle(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {visible.length ? visible.map((i, idx) => (
        <div className="feed-item" key={`${i.at}-${idx}`}>
          <div className="head">
            <span className={`type ${i.type}`}>{i.type}</span>
            <span>{i.title}</span>
            <span className="when">{ageText(i.at)}</span>
          </div>
          {i.detail && <div className="detail">{i.detail}</div>}
        </div>
      )) : (
        <EmptyBox title="Sin actividad con esos filtros." />
      )}
      {items.length < total && (
        <button
          className="load-more"
          type="button"
          onClick={async () => { loadingMore.current = true; await load(page + 1, false); loadingMore.current = false; }}
        >
          Cargar 25 más ({items.length}/{total})
        </button>
      )}
    </>
  );
}
