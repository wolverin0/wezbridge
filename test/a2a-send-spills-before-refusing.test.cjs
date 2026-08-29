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
 * Se lee el fuente en vez de importar el handler porque `handleToolCall` no se
 * exporta y `mcp-server.cjs` arranca un servidor MCP al requerirse. Es el mismo
 * camino que ya usan `mcp-server-v35-tools.test.cjs` y compañía.
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
