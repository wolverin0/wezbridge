'use strict';
/**
 * a2a-length-guard.cjs — refuse over-long A2A bodies BEFORE they are sent.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES INLINE: mcp-server.cjs has no
 * exports and requiring it would start a server, so anything defined there can
 * only be "tested" by grepping the source. That is not a test. The first
 * version of this guard was verified exactly that way, and a mutation that
 * disabled the condition outright left the suite green — because the constant
 * name still appeared inside the refusal message the guard returns. A test that
 * survives the removal of the thing it tests is not a test.
 *
 * WHY THE GUARD EXISTS AT ALL: a2a_send already detected truncation and
 * reported DELIVERY INTEGRITY FAILURE — after sending. A warning that arrives
 * afterwards only teaches the caller to retry shorter, so the rule is
 * re-learned every session and obeyed only once caught. On 2026-08-13 pane-0
 * truncated FIVE envelopes in one session, one of them an hour after publishing
 * a self-audit about this exact failure.
 *
 * The failure being prevented is SILENT ON THE RECEIVING END: the peer gets a
 * partial instruction with no way to know something was cut. That asymmetry is
 * why the default is refuse rather than warn.
 */

/**
 * Soft ceiling before the tool refuses and points the caller at a file.
 *
 * NOT a hard protocol limit (that is INPUT_BYTE_LIMITS.prompt, 16KB). This is
 * where recipient composers were observed truncating in practice. Provisional,
 * from one day's sample: every envelope under ~1000 chars arrived intact; the
 * ones that truncated were ~1400+. Raise it if the evidence changes — but the
 * default must stay refuse.
 */
const A2A_BODY_SOFT_LIMIT = Number(process.env.WEZBRIDGE_A2A_SOFT_LIMIT) || 1200;

/**
 * PURE: the refusal text for an over-long body, or null to allow.
 *
 * `allowLong` must be boolean true to opt out. Truthy strings and numbers do
 * NOT count — an escape hatch that opens on any truthy value is one a caller
 * trips accidentally, which defeats the point of having it.
 */
function a2aLengthRefusal(body, allowLong, limit = A2A_BODY_SOFT_LIMIT) {
  const len = String(body).length;
  if (len <= limit || allowLong === true) return null;
  return `a2a_send REFUSED: body is ${len} chars (soft limit ${limit}). `
    + 'Long envelopes get truncated by the recipient composer and arrive silently incomplete.\n\n'
    + 'Do this instead: write the content to a repo file (e.g. _intel/briefs/<topic>.md) and send a '
    + 'short pointer to that path. The peer reads the file; nothing is lost in transit.\n\n'
    + 'If the payload genuinely must go inline, re-send with allow_long: true.';
}


/**
 * DERRAMA un cuerpo largo a disco y devuelve un PUNTERO corto en su lugar.
 *
 * Por que existe, y por que no alcanzaba con refusar: el guard de arriba tenia
 * razon en el diagnostico y se quedo corto en el remedio. Medido el 2026-08-29
 * en UNA sesion: la refusion se disparo SEIS veces, el emisor acorto a mano las
 * seis, y DOS de esos reenvios "cortos" volvieron igual con delivered:truncated.
 * Si el sistema ya sabe que el cuerpo no entra Y ya sabe cual es el remedio, no
 * hay motivo para devolverselo al llamador: derramar es determinista, acortar a
 * ojo no.
 *
 * LA INVARIANTE: el puntero NUNCA puede pasarse del limite. Un puntero truncado
 * deja al receptor con una RUTA cortada, que es peor que un cuerpo cortado
 * porque parece completa. Por eso el preview se recorta contra el espacio que
 * queda, y el corr del llamador se acota antes de entrar al nombre del archivo.
 *
 * FAIL-SOFT: si el disco falla, devuelve el cuerpo ORIGINAL con el error. Perder
 * el mensaje seria peor que arriesgar un truncado — esa eleccion es del llamador.
 *
 * @returns {{spilled: boolean, body: string, path?: string, error?: string}}
 */
function a2aSpill({ body, corr, limit = A2A_BODY_SOFT_LIMIT, dir, writeFile, now = () => new Date() }) {
  const text = String(body ?? '');
  if (text.length <= limit) return { spilled: false, body: text };

  // El corr viene del llamador: se sanea y se acota ANTES de formar el nombre,
  // para que no pueda empujar el puntero por encima del limite.
  const slug = String(corr || 'sin-corr').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  const stamp = now().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${slug}-${stamp}.md`;
  const full = `${String(dir || '.').replace(/[\/]+$/, '')}/${file}`;

  const header = `[CUERPO DERRAMADO: ${text.length} chars, no entraba en ${limit}]\n`
    + `Completo en: ${full}\n`
    + `Leelo con:   cat "${full}"\n`;

  try {
    writeFile(full, `<!-- a2a spill · corr=${corr} · ${text.length} chars · ${now().toISOString()} -->\n\n${text}\n`);
  } catch (err) {
    return { spilled: false, body: text, error: String((err && err.message) || err) };
  }

  // El preview se recorta contra lo que sobra, no contra un numero fijo: con un
  // corr largo el header crece y el preview tiene que ceder, no el limite.
  const marker = '\n--- primeras lineas ---\n';
  const room = limit - header.length - marker.length - 1;
  const pointer = room > 40
    ? `${header}${marker}${text.slice(0, room)}`
    : header.slice(0, limit);

  return { spilled: true, body: pointer, path: full };
}

module.exports = { a2aLengthRefusal, a2aSpill, A2A_BODY_SOFT_LIMIT };
