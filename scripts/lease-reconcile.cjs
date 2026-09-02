'use strict';
/**
 * lease-reconcile.cjs — ¿el owner de cada lease abierta sigue EXISTIENDO?
 * Dos formas de owner: `pane-N` (se verifica contra el censo de WezTerm, con
 * cwd coincidente) y `eve:<jobId>` (W5: se verifica con `executorLiveness`
 * inyectado; sin funcion o sin respuesta => lease-owner-unverifiable, jamas
 * "sano"). Categorias: dead-owner-lease · lease-owner-unverifiable ·
 * lease-census-unavailable.
 *
 * T-0272. MEDIDO el 2026-08-25: T-0199 se despachó, pane-39 tomó una lease de
 * 1440 minutos y murió. 22 horas de "running" en el tablero, y el steward la
 * dejó en paz JUSTO porque la lease seguía viva. El único detector era el
 * vencimiento (abandoned-lease), así que el piso de detección era la DURACIÓN
 * de la lease. Este módulo pregunta lo que nadie preguntaba: no "¿venció?"
 * sino "¿el pane que la sostiene existe, y es la misma sesión?".
 *
 * Dos sutilezas que son el contenido real:
 *
 * 1. "El pane existe" NO alcanza — los ids se reciclan. pane-39 sostuvo T-0067
 *    el 2026-08-01 y reapareció el 08-25 siendo otra sesión en otro repo. La
 *    comprobación honesta es owner vivo Y cwd del pane coincidente con el repo
 *    de la tarjeta.
 * 2. NO fusionar con el vencimiento (el error de T-0269): un pane VIVO con una
 *    lease larga sin vencer es sano y no produce hallazgo. Vencimiento y
 *    existencia son detectores distintos con víctimas distintas.
 *
 * Y la regla de la casa sobre fallos de medición: si el censo no se puede
 * obtener, esto NO devuelve [] — devuelve un hallazgo que lo dice. Un detector
 * que responde "todo sano" cuando en realidad no pudo mirar es el instrumento
 * mentiroso que este repo vino cazando toda la semana.
 */
const { spawnSync } = require('node:child_process');

const TERMINAL = new Set(['done', 'cancelled']);

/**
 * Dos formas de owner, dos reconciliadores distintos:
 *   "pane-33 (wezbridge)" -> { paneId: 33 }   (censo de WezTerm)
 *   "eve:<jobId>"         -> { executor: 'eve', jobId }   (vivacidad inyectada)
 * Cualquier otra cosa -> null (ilegible, y se dice).
 *
 * W5: un job de FinalOrchestra NO tiene pane. Hasta hoy su lease caia en
 * "owner ilegible" y producia un hallazgo falso por cada tarjeta despachada a
 * Eve — que es exactamente como se entrena a todo el mundo a ignorar al steward.
 */
function parseOwner(owner) {
  const eve = /^eve:(\S+)$/.exec(String(owner || '').trim());
  if (eve) return { executor: 'eve', jobId: eve[1] };
  const m = /pane-(\d+)/.exec(String(owner || ''));
  return m ? { paneId: Number(m[1]) } : null;
}

/**
 * ¿El cwd del pane corresponde al repo de la tarjeta? Compara el último
 * segmento del repo declarado contra los segmentos del cwd real, con la misma
 * normalización floja que usa pane-identity (case-insensitive, file:// y %20
 * decodificados). Repos con path compuesto ("a - Copy/whatsappbot-final")
 * comparan por su hoja.
 */
function repoMatchesCwd(repo, cwd) {
  if (!repo || !cwd) return false;
  let s = String(cwd);
  try { s = decodeURIComponent(s); } catch { /* malformado: comparar crudo */ }
  s = s.replace(/^file:\/\/\/?/, '').replace(/[/\\]+$/, '');
  const cwdParts = s.split(/[/\\]/).filter(Boolean).map((p) => p.trim().toLowerCase());
  const repoLeaf = String(repo).split(/[/\\]/).filter(Boolean).pop().trim().toLowerCase();
  return cwdParts.includes(repoLeaf);
}

/**
 * Censo por defecto: wezterm cli list en vivo. Devuelve null si no se pudo
 * medir — y null se REPORTA, no se traga (ver el hallazgo census-unavailable).
 */
function liveCensus() {
  const res = spawnSync('wezterm', ['cli', '--prefer-mux', '--no-auto-start', 'list', '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
  if (res.error || res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout).map((p) => ({ pane_id: p.pane_id, cwd: p.cwd || '' }));
  } catch { return null; }
}

/**
 * Reconcilia cada lease abierta contra el censo. Pura: (tasks, census, now) ->
 * findings con la misma forma que emite fleet-steward (id, repo, state, title,
 * owner, age_hours, category, why).
 *
 * "Lease abierta" = tarjeta en estado NO terminal con lease.owner escrito, sin
 * importar el estado FSM ni si la lease venció: las cinco tarjetas no-running
 * con lease vencida del despacho (T-0229, T-0232, T-0241, T-0253, T-0105) son
 * exactamente lo que un barrido de solo-'running' nunca limpia.
 */
function reconcileLeases(tasks, census, now = Date.now(), opts = {}) {
  const open = (tasks || []).filter((t) => t && t.lease && t.lease.owner && !TERMINAL.has(t.state));
  if (open.length === 0) return [];

  // La vivacidad de un executor remoto no se adivina: se INYECTA (drill:
  // stub.isAlive; vivo: task_get de FinalOrchestra). Sin funcion no hay
  // veredicto, y el no-veredicto se REPORTA — nunca se traduce a "sano".
  const executorLiveness = typeof opts.executorLiveness === 'function' ? opts.executorLiveness : null;
  // Las leases de Eve no dependen del censo de WezTerm: se reconcilian aunque
  // el censo no se haya podido obtener.
  const needsCensus = open.filter((t) => {
    const p = parseOwner(t.lease.owner);
    return !(p && p.executor === 'eve');
  });

  if (needsCensus.length > 0 && !Array.isArray(census)) {
    return [{
      id: null, repo: null, state: null, title: null, owner: null, age_hours: 0,
      category: 'lease-census-unavailable',
      why: `el censo de WezTerm no se pudo obtener: ${needsCensus.length} lease(s) abiertas quedaron SIN reconciliar este tick — esto no es "todo sano", es "no se pudo mirar"`,
    }];
  }

  const byId = new Map((Array.isArray(census) ? census : []).map((p) => [Number(p.pane_id), p]));
  const findings = [];
  for (const t of open) {
    const ageH = Math.round((now - Date.parse(t.lease.expires_at || 0)) / 36e5) || 0;
    const common = {
      id: t.id, repo: t.repo, state: t.state, title: t.title,
      owner: t.lease.owner, age_hours: Math.max(0, ageH),
      category: 'dead-owner-lease',
    };
    const parsed = parseOwner(t.lease.owner);
    if (parsed && parsed.executor === 'eve') {
      const finding = reconcileEveLease(t, common, parsed.jobId, executorLiveness);
      if (finding) findings.push(finding);
      continue;
    }
    if (!parsed) {
      findings.push({ ...common, why: `${t.id}: owner de lease ilegible ("${t.lease.owner}") — sin pane-N no hay a quien reconciliar; corregir el owner o liberar la lease` });
      continue;
    }
    const pane = byId.get(parsed.paneId);
    if (!pane) {
      findings.push({ ...common, why: `${t.id}: el owner pane-${parsed.paneId} no existe en el censo vivo — el pane murió o se renumeró; la tarjeta figura ${t.state} y nadie la está trabajando. Liberar la lease o re-despachar` });
      continue;
    }
    if (!String(pane.cwd || '').trim()) {
      // Medido en la primera corrida real (2026-09-01): el censo puede devolver
      // panes con cwd VACIO — un pane muerto residual, o una lectura transitoria
      // (la leccion del Monitor v3: un empty read solo no prueba muerte). Eso NO
      // es evidencia de id reciclado: es evidencia de que no se pudo medir, y se
      // dice exactamente eso en su propia categoria.
      findings.push({ ...common, category: 'lease-owner-unverifiable', why: `${t.id}: pane-${parsed.paneId} figura en el censo pero su cwd vino vacío — no se puede confirmar ni descartar al owner (${t.lease.owner}) este tick; si persiste varios ticks, tratarlo como muerto` });
      continue;
    }
    if (!repoMatchesCwd(t.repo, pane.cwd)) {
      findings.push({ ...common, why: `${t.id}: pane-${parsed.paneId} existe pero su cwd (${pane.cwd}) no corresponde al repo de la tarjeta (${t.repo}) — id reciclado por otra sesión, como pane-39/T-0199 el 2026-08-25. El owner real está muerto` });
      continue;
    }
    // Vivo y en su repo: sano. La duración de la lease no es asunto de este
    // detector — esa semántica es de abandoned-lease y NO se fusiona acá.
  }
  return findings;
}

/**
 * Owner `eve:<jobId>`: sano solo si la liveness inyectada dice EXPLICITAMENTE
 * que si. `undefined`, ausencia de funcion o una funcion que explota son todas
 * la misma cosa — no se pudo medir — y se reportan como tal.
 */
function reconcileEveLease(t, common, jobId, executorLiveness) {
  if (!executorLiveness) {
    return {
      ...common,
      category: 'lease-owner-unverifiable',
      why: `${t.id}: la lease la sostiene eve:${jobId} y no se inyectó forma de verificar su vivacidad — no se puede confirmar ni descartar al owner este tick; cablear executorLiveness (task_get de FinalOrchestra) antes de creerle a esta lease`,
    };
  }
  let alive;
  try { alive = executorLiveness(jobId); } catch { alive = undefined; }
  if (alive === true) return null; // job vivo: sano, aunque no exista ningún pane
  if (alive === false) {
    return {
      ...common,
      category: 'dead-owner-lease',
      why: `${t.id}: eve:${jobId} no vive — FinalOrchestra no reconoce el job que sostiene la lease; la tarjeta figura ${t.state} y nadie la está trabajando. Liberar la lease o re-despachar`,
    };
  }
  return {
    ...common,
    category: 'lease-owner-unverifiable',
    why: `${t.id}: la vivacidad de eve:${jobId} no se pudo medir este tick (FinalOrchestra no respondió) — ni sano ni muerto; si persiste varios ticks, tratarlo como muerto`,
  };
}

// NOTA PARA EL CABLEADO (scripts/fleet-steward.cjs, que es de otro dueño):
// `audit(tasks, now, dir, { census, executorLiveness })` tiene que REENVIAR
// executorLiveness a esta funcion — hoy su call site llama
// `reconcileLeases(tasks, opts.census, now)` y come el cuarto argumento, con lo
// cual toda lease de Eve sale 'lease-owner-unverifiable'. Es una linea:
// `reconcileLeases(tasks, opts.census, now, { executorLiveness: opts.executorLiveness })`.
/**
 * T31 check 8 (2026-09-01): vivacidad de un job de Eve leida del control plane
 * (GET /api/jobs/<id>, sin auth, 200 con {job:{status}}). Vivo mientras el job
 * esta en curso; muerto en estado terminal (la lease deberia haber caido con el
 * result); undefined = no se pudo medir (control plane mudo, JSON roto, estado
 * desconocido) y la lease queda lease-owner-unverifiable, nunca "sana".
 */
const EVE_ALIVE = new Set(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_INPUT', 'APPROVED']);
const EVE_DEAD = new Set(['BLOCKED', 'FAILED', 'CANCELLED', 'SUCCEEDED', 'COMPLETED']);
function classifyEveStatus(status) {
  if (typeof status !== 'string') return undefined;
  const s = status.toUpperCase();
  if (EVE_ALIVE.has(s)) return true;
  if (EVE_DEAD.has(s)) return false;
  return undefined;
}

function curlFetcher(url) {
  const r = spawnSync('curl', ['-s', '-m', '5', url], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`curl ${r.status}: ${r.error ? r.error.message : ''}`);
  return r.stdout;
}

function eveLivenessFromControlPlane({ baseUrl = process.env.FINALORCHESTRA_URL || process.env.V_CONTROL_PLANE_URL || 'http://127.0.0.1:3100', fetcher = curlFetcher } = {}) {
  const base = String(baseUrl).endsWith('/') ? String(baseUrl).slice(0, -1) : String(baseUrl);
  return (jobId) => {
    try {
      const body = fetcher(`${base}/api/jobs/${jobId}`);
      const data = JSON.parse(body);
      return classifyEveStatus(data && data.job && data.job.status);
    } catch { return undefined; }
  };
}

module.exports = { reconcileLeases, liveCensus, repoMatchesCwd, parseOwner, classifyEveStatus, eveLivenessFromControlPlane };
