'use strict';
/**
 * T-0328: `to_project=infra` aterrizo en el pane de wezbridge (2026-09-02 22:11-22:15Z,
 * tres filas en _intel/queues/infra.jsonl con resolved_pane=2). Hipotesis de la
 * tarjeta, A CONFIRMAR y no a asumir: infra/ es SUBDIRECTORIO de Py Apps, asi que la
 * resolucion por proyecto "encuentra primero al hijo mas parecido o cae al pane 2".
 *
 * Este archivo fija la propiedad que la hipotesis dice rota: con un censo donde
 * infra y wezbridge son hermanos bajo Py Apps, `resolve('infra')` devuelve el pane
 * de infra y NUNCA el de wezbridge, en las tres formas en que el censo ha
 * reportado al pane de infra (cwd .../infra; cwd colapsado a la raiz con tab
 * "infra"; raiz con tab generica = sin pane, no un hermano). Y lo mismo para los
 * otros proyectos que viven como subdirectorio del cwd raiz (marketing,
 * frontendesigner).
 *
 * RESULTADO DE LA CORRIDA EN HEAD (2026-09-06, antes de tocar nada): VERDE. El
 * resolutor no confunde hermanos: un `if` de exclusion que lo hiciera devolver
 * wezbridge rompe A1-A3. La hipotesis del subdirectorio queda REFUTADA por test;
 * la causa de las tres filas es otra (ver el result de T-0328: los sobres salieron
 * 6,5 h despues del fix de T-0260 "un solo espacio de pane_id", desde un MCP que
 * seguia corriendo codigo anterior; en el espacio de ids de la GUI "2" era infra
 * y en el del mux "2" era wezbridge). Se conserva como guardia de regresion.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const id = require('../src/pane-identity.cjs');

const ROOT = 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps';

// Censo del 2026-09-02 reconstruido: pedrito (emisor), wezbridge y los tres
// proyectos que viven como subdirectorio de la raiz.
const SUBDIR_CENSUS = [
  { pane_id: 2, tab_title: 'wezbridge', cwd: `${ROOT}/wezbridge` },
  { pane_id: 9, tab_title: 'infra', cwd: `${ROOT}/infra` },
  { pane_id: 11, tab_title: 'marketing', cwd: `${ROOT}/marketing/` },
  { pane_id: 12, tab_title: 'frontendesigner', cwd: `${ROOT}/frontendesigner` },
  { pane_id: 10, tab_title: 'pedrito', cwd: `${ROOT}/pedrito` },
];
const WEZBRIDGE = 2;

function withInfraAtRoot(census, tab = 'infra') {
  return census.map((p) => (p.pane_id === 9 ? { ...p, cwd: ROOT, tab_title: tab } : p));
}

test('A1: infra como subdirectorio de Py Apps resuelve al pane de infra, nunca al de wezbridge', () => {
  const hit = id.resolve('infra', SUBDIR_CENSUS);
  assert.strictEqual(hit.paneId, 9, `resolvio a ${hit.paneId}: ${JSON.stringify(hit)}`);
  assert.notStrictEqual(hit.paneId, WEZBRIDGE, 'un sobre a infra en el pane de wezbridge es peor que uno perdido');
  assert.strictEqual(hit.matchedBy, 'cwd');
  assert.deepStrictEqual(hit.ambiguous, []);
});

test('A2: infra con cwd en la RAIZ (como hoy, pane 1) resuelve por la etiqueta de la tab, no por parecido de ruta', () => {
  const hit = id.resolve('infra', withInfraAtRoot(SUBDIR_CENSUS));
  assert.strictEqual(hit.paneId, 9, JSON.stringify(hit));
  assert.strictEqual(hit.matchedBy, 'tab_title');
});

test('A3: infra en la raiz con tab generica = NO hay pane (se encola), jamas un hermano', () => {
  const hit = id.resolve('infra', withInfraAtRoot(SUBDIR_CENSUS, 'Py Apps'));
  assert.strictEqual(hit.paneId, null, `debia quedar sin pane y devolvio ${hit.paneId}`);
  assert.match(hit.warning, /no live pane for "infra"/);
});

test('A4 (sweep): marketing y frontendesigner, hermanos bajo la misma raiz, resuelven a su propio pane', () => {
  for (const [wanted, expected] of [['marketing', 11], ['frontendesigner', 12], ['infra', 9], ['wezbridge', 2]]) {
    const hit = id.resolve(wanted, SUBDIR_CENSUS);
    assert.strictEqual(hit.paneId, expected, `${wanted} -> ${hit.paneId}: ${JSON.stringify(hit)}`);
    assert.deepStrictEqual(hit.ambiguous, [], `${wanted} ambiguo: ${JSON.stringify(hit)}`);
  }
});

test('A5: el nombre de la raiz ("Py Apps") no arrastra a ningun subdirectorio', () => {
  // Pedir el proyecto raiz no puede devolver wezbridge ni infra: solo un pane cuya
  // carpeta SEA la raiz (o su etiqueta), y si no lo hay, ninguno.
  const none = id.resolve('Py Apps', SUBDIR_CENSUS);
  assert.strictEqual(none.paneId, null, JSON.stringify(none));
  const atRoot = id.resolve('Py Apps', withInfraAtRoot(SUBDIR_CENSUS, 'Py Apps'));
  assert.strictEqual(atRoot.paneId, 9, JSON.stringify(atRoot));
});
