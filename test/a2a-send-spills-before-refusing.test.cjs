'use strict';
/**
 * EL CABLEADO, no la función. `a2aSpill` ya tiene su suite
 * (`a2a-spill-to-pointer.test.cjs`) y pasa entera — y aun así hoy, 2026-08-29,
 * `a2a_send` me devolvió la REFUSIÓN dos veces seguidas y tuve que acortar el
 * cuerpo a mano las dos. La función estaba bien; nadie probaba que el handler
 * la llamara, ni en qué orden.
 *
 * Es la misma clase de defecto que vengo midiendo todo el día: un instrumento
 * que reporta algo real pero no lo que uno cree que mide. "Los tests del
 * derrame pasan" nunca significó "a2a_send derrama".
 *
 * QUÉ FIJA ESTE TEST, y es una sola propiedad con dos mitades:
 *
 *   1. el handler de `a2a_send` LLAMA a `a2aSpill`, y
 *   2. lo llama ANTES de `a2aLengthRefusal`.
 *
 * El orden es la mitad que importa. Refusar primero y derramar después es
 * indistinguible de no derramar: el llamador ya se llevó el error y ya está
 * acortando a ojo. Invertir esas dos líneas es una mutación de un renglón que
 * ningún test de `a2a-spill-to-pointer.test.cjs` detecta — este sí.
 *
 * DOS CAPAS, y la segunda es la que vale (T-0307, 2026-09-05):
 *
 *   - A1..B2 leen el FUENTE: baratas, atrapan la inversión de orden, pero
 *     prueban una propiedad del ARCHIVO. La auditoría de mutación del
 *     2026-09-01 lo demostró: con el bloque `if (args.allow_long !== true)`
 *     dead-codeado a `if (false && ...)` seguían 5/5 en verde, porque los dos
 *     tokens y su orden sobreviven dentro de un `if (false)`.
 *   - E1..E3 LEVANTAN EL SERVIDOR (mismo camino que mcp-server-v35-tools:
 *     stdio JSON-RPC contra src/mcp-server.cjs con el wezterm de mentira de
 *     test/mocks) y llaman a a2a_send de verdad: si el bloque no es
 *     ALCANZABLE, no hay archivo en _intel/spill y E1 rompe. Ese es el hueco
 *     que ningún grep del fuente puede cerrar.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
const SRC = fs.readFileSync(ENTRY, 'utf8');

/**
 * Recorta el cuerpo del `case 'a2a_send':` hasta el siguiente `case` de nivel
 * superior. Sin esto, buscar `a2aSpill` en todo el archivo daría verde con la
 * llamada viviendo en cualquier otra herramienta.
 */
function bloqueA2aSend(src) {
  const abre = src.indexOf("case 'a2a_send':");
  assert.notStrictEqual(abre, -1,
    "no existe un case 'a2a_send' en mcp-server.cjs — si se renombró la herramienta, este test tiene que renombrarse con ella, no borrarse");
  const resto = src.slice(abre + 1);
  const siguiente = resto.search(/\n {4,6}case '/);
  return sinComentarios(siguiente === -1 ? resto : resto.slice(0, siguiente));
}

/**
 * Los comentarios se van ANTES de medir. Esto no es higiene: es el test que
 * casi se me escapa. Al mutar `body = sp.body;` a `// body = sp.body;` el caso
 * B2 siguió en VERDE, porque la expresión hacía match contra la línea comentada.
 * Un test que aprueba código anulado es peor que ninguno — afirma una propiedad
 * que ya no se cumple. La mutación existe justo para encontrar esto, y lo
 * encontró: el defecto estaba en el test, no en el fuente.
 */
function sinComentarios(txt) {
  return txt
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const BLOQUE = bloqueA2aSend(SRC);

test('A1: el handler de a2a_send llama a a2aSpill', () => {
  assert.match(BLOQUE, /a2aSpill\s*\(/,
    'a2a_send no derrama: un cuerpo largo le vuelve al emisor como error y lo acorta a mano — medido dos veces el 2026-08-29');
});

test('A2 (LA propiedad): derrama ANTES de refusar', () => {
  const iSpill = BLOQUE.indexOf('a2aSpill(');
  const iRefus = BLOQUE.indexOf('a2aLengthRefusal(');

  assert.notStrictEqual(iSpill, -1, 'sin llamada a a2aSpill no hay orden que comprobar');
  assert.notStrictEqual(iRefus, -1,
    'la refusión tiene que seguir existiendo: es el respaldo para cuando el disco no coopera');

  assert.ok(iSpill < iRefus,
    'a2aLengthRefusal corre antes que a2aSpill: refusar primero es indistinguible de no derramar, '
    + 'porque el llamador ya se llevó el error y ya está acortando a ojo');
});

test('A3: la refusión sobrevive como respaldo, no se la reemplaza', () => {
  assert.match(BLOQUE, /a2aLengthRefusal\s*\(/,
    'borrar la refusión deja un fallo de disco en silencio: el cuerpo largo saldría entero y lo truncaría el composer del receptor');
});

test('B1: el derrame está condicionado a que NO se haya pedido allow_long', () => {
  const iAllow = BLOQUE.indexOf('allow_long');
  const iSpill = BLOQUE.indexOf('a2aSpill(');
  assert.ok(iAllow !== -1 && iAllow < iSpill,
    'allow_long: true es una decisión explícita del emisor — derramarle igual le cambia el mensaje por un puntero que no pidió');
});

test('B2: el cuerpo que se envía es el del derrame, no el original', () => {
  assert.match(BLOQUE, /body\s*=\s*sp\.body/,
    'derramar a disco y después mandar el cuerpo original es el peor de los dos mundos: escribe el archivo Y trunca el mensaje');
});

// ─── E: el handler DE VERDAD, con el servidor levantado ───────────────────────
//
// `handleToolCall` no se exporta y requerir mcp-server.cjs engancha stdin, así
// que se lo levanta como proceso hijo y se le habla por stdio (JSON-RPC por
// línea). El wezterm es test/mocks/wezterm-mock.cjs (censo: pane 1 en /tmp), así
// que ningún test toca un pane real. from_pane va explícito (camino documentado
// para emisores externos) y to_pane es un id que el censo NO tiene: el handler
// llega al derrame y sigue hasta el reporte de entrega contra el mock. Lo que se mide es
// el efecto en disco, no el texto del fuente.
require('./setup.cjs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const LIMIT = require('../src/a2a-length-guard.cjs').A2A_BODY_SOFT_LIMIT;
const CUERPO_LARGO = 'derrame-T-0307 '.repeat(Math.ceil((LIMIT * 2) / 15));

function callA2aSend(args, env, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, WEZTERM_PANE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(stdout.slice(0, nl).trim()).result); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}; stderr=${stderr}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a2a_send', arguments: args } }) + '\n');
  });
}

const textoDe = (res) => res.content.map((c) => c.text).join('\n');

test('E1 (ALCANZABILIDAD): un cuerpo largo enviado por a2a_send queda derramado en _intel/spill', async () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 't0307-spill-'));
  const res = await callA2aSend(
    { from_pane: 1, to_pane: 424242, type: 'request', corr: 'T-0307-e1', body: CUERPO_LARGO },
    { WEZBRIDGE_INTEL_DIR: intel },
  );
  const texto = textoDe(res);
  assert.doesNotMatch(texto, /a2a_send REFUSED/,
    'refusó en vez de derramar: el emisor vuelve a acortar a ojo (medido 6 veces el 2026-08-29)');
  const spillDir = path.join(intel, 'spill');
  assert.ok(fs.existsSync(spillDir),
    `el handler NO llegó al derrame: no existe ${spillDir}. Con el bloque dead-codeado (if (false && ...)) A1..B2 siguen en verde y este es el único que lo ve. Respuesta: ${texto.slice(0, 200)}`);
  const archivos = fs.readdirSync(spillDir);
  assert.strictEqual(archivos.length, 1, `esperaba un archivo derramado, hay ${archivos.length}`);
  assert.match(archivos[0], /^T-0307-e1-/, 'el nombre del derrame lleva el corr del llamador');
  const contenido = fs.readFileSync(path.join(spillDir, archivos[0]), 'utf8');
  assert.ok(contenido.includes(CUERPO_LARGO),
    'el archivo derramado no contiene el cuerpo completo: el puntero apuntaría a un texto incompleto');
  // Sanidad: el handler siguió DESPUÉS del derrame hasta su reporte de entrega
  // (con el wezterm de mentira el censo no tiene agentes, así que el destino no
  // se bloquea y el envío llega al mock; lo que importa es que hubo derrame
  // ANTES de eso, no cómo terminó la entrega).
  assert.match(texto, /"submitted"/,
    'el handler no llegó a su reporte de entrega: se cortó entre el derrame y el envío');
});

test('E2 (RESPALDO): si el disco no coopera, a2a_send refusa con el error del derrame, no manda el cuerpo entero', async () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 't0307-nodisk-'));
  fs.writeFileSync(path.join(intel, 'spill'), 'soy un archivo, no un directorio');
  const res = await callA2aSend(
    { from_pane: 1, to_pane: 424242, type: 'request', corr: 'T-0307-e2', body: CUERPO_LARGO },
    { WEZBRIDGE_INTEL_DIR: intel },
  );
  const texto = textoDe(res);
  assert.strictEqual(res.isError, true, `tenía que ser error; respuesta: ${texto.slice(0, 200)}`);
  assert.match(texto, /a2a_send REFUSED/, 'sin refusión de respaldo el cuerpo largo sale entero y lo trunca el composer del receptor');
  assert.match(texto, /derrame automatico fallo/, 'la refusión tiene que decir POR QUÉ no derramó');
});

test('E3 (OPT-OUT): allow_long: true no derrama nada', async () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 't0307-allow-'));
  const res = await callA2aSend(
    { from_pane: 1, to_pane: 424242, type: 'request', corr: 'T-0307-e3', body: CUERPO_LARGO, allow_long: true },
    { WEZBRIDGE_INTEL_DIR: intel },
  );
  const texto = textoDe(res);
  assert.doesNotMatch(texto, /a2a_send REFUSED/, 'allow_long: true es la decisión explícita del emisor');
  assert.ok(!fs.existsSync(path.join(intel, 'spill')),
    'derramó igual con allow_long: true — le cambió el mensaje por un puntero que no pidió');
});
