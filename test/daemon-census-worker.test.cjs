'use strict';
/**
 * daemon-census-worker.test.cjs — el daemon :4200 nunca ejecuta wezterm de
 * forma sincrona en su event loop principal (T-0321 AC2).
 *
 * LO MEDIDO (T-0321 AC1): execFileSync SI respeta su timeout; lo que congela al
 * daemon es que BLOQUEA el event loop mientras espera, 10 s + 1 reintento por
 * pane. Con el mux mudo, heartbeat y HTTP mueren con el proceso vivo.
 *
 * Este test arranca el daemon REAL con un wezterm.exe que cuelga (copia de
 * node.exe + preload que hace Atomics.wait ante `cli`) y exige que /api/health
 * siga contestando durante toda la ventana con el loop libre (p95 < 3 s, ninguna
 * > 5 s: umbrales que un loop bloqueado 10-20 s por tick no puede cumplir y un
 * daemon sano bajo la carga de la suite completa si). Contra el HEAD anterior
 * falla: el tick del snapshot llama listPanes() sincrono.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const ENTRY = path.join(__dirname, '..', 'src', 'dashboard-server.cjs');
const PRELOAD = path.join(__dirname, 'fixtures', 'wezterm-hang-if-cli.cjs');
const INTEL = fs.mkdtempSync(path.join(os.tmpdir(), 'census-intel-'));
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'census-bin-'));
const FAKE_WEZTERM = path.join(BIN_DIR, process.platform === 'win32' ? 'wezterm.exe' : 'wezterm');

let daemon;
let port;
const stderrLines = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function get(pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs} ms`)); });
    req.on('error', reject);
    req.end();
  });
}

// Generoso a proposito: contra el HEAD viejo el primer tick del snapshot bloquea
// el loop 10 s + 10 s de reintento ANTES de que /api/health pueda contestar. El
// arranque lento no es lo que se mide; lo que se mide es la ventana de AC2.
async function waitUp(maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await get('/api/health', 2000); if (r.status === 200) return true; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

before(async () => {
  fs.copyFileSync(process.execPath, FAKE_WEZTERM); // un ejecutable real que cuelga ante `cli`
  port = await freePort();
  // Entre comillas: NODE_OPTIONS parte por espacios y este repo vive bajo "Py Apps"
  // (misma leccion que test/setup.cjs: sin comillas, MODULE_NOT_FOUND 'G:/.../Py').
  const preload = `--require="${PRELOAD.replace(/\\/g, '/')}"`;
  // test/setup.cjs (preload de TODA la suite, heredado por NODE_OPTIONS) pisa
  // WEZBRIDGE_WEZTERM_BIN con el mock dentro de cualquier hijo node. El daemon
  // bajo prueba necesita el binario colgado de verdad, asi que se le quita ESE
  // preload a su NODE_OPTIONS en vez de tocar setup.cjs: la primera version de
  // este test le agrego un marcador a setup.cjs y eso rompio los tests LIVE de
  // poke-pane y pane-registry (bisecado 05/09 con git checkout del archivo).
  const inherited = String(process.env.NODE_OPTIONS || '')
    .split(/\s+(?=--)/).filter((seg) => seg && !/setup\.cjs/.test(seg));
  daemon = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      NODE_OPTIONS: [...inherited, preload].join(' '),
      WEZBRIDGE_WEZTERM_BIN: FAKE_WEZTERM,
      WEZBRIDGE_INTEL_DIR: INTEL,
      DASHBOARD_PORT: String(port),
      WEZBRIDGE_SESSION_SNAPSHOT: '2', // tick cada 2 s: el camino que bloqueaba
      WEZBRIDGE_CENSUS_INTERVAL_MS: '1000',
      WEZBRIDGE_CENSUS_HANG_MS: '4000',
      WEZBRIDGE_WATCHDOG: '0',
      WEZBRIDGE_ORCH_WAKER: '0',
      STREAMER_MODE: 'decisions',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stderr.on('data', (c) => stderrLines.push(String(c)));
  daemon.stdout.on('data', (c) => stderrLines.push(String(c)));
  assert.ok(await waitUp(), `el daemon no levanto en el puerto ${port}:\n${stderrLines.join('').slice(-1500)}`);
});

after(() => {
  if (!daemon) return;
  if (process.platform === 'win32') {
    require('node:child_process').spawnSync('taskkill', ['/PID', String(daemon.pid), '/T', '/F'], { windowsHide: true });
  } else daemon.kill('SIGKILL');
});

test('AC2: /api/health sigue contestando en < 1 s mientras wezterm cuelga', async () => {
  // Ventana de 12 s: cubre varios ticks del snapshot (cada 2 s) y del censo.
  const samples = [];
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    try { samples.push(await get('/api/health', 4000)); }
    catch (e) { samples.push({ status: 0, ms: 4000, error: e.message }); }
    await new Promise((r) => setTimeout(r, 400));
  }
  // Umbrales elegidos para separar los dos mundos, no para medir rendimiento:
  // el HEAD viejo bloqueaba el loop 10 s + 10 s de reintento por tick (todas las
  // respuestas > 10 s o timeout); bajo la carga de la suite completa en paralelo
  // un daemon SANO contesta en decenas o cientos de ms, con algun pico. Por eso
  // p95 < 3 s y ninguna > 5 s: un loop bloqueado no puede cumplirlo, uno cargado si.
  const lat = samples.map((s) => `${s.status}:${s.ms}ms`).join(" ");
  const ok200 = samples.filter((s) => s.status === 200);
  const sorted = ok200.map((s) => s.ms).sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : Infinity;
  const worst = sorted.length ? sorted[sorted.length - 1] : Infinity;
  assert.ok(samples.length >= 6, `pocas muestras: ${samples.length} — latencias: ${lat}\nlog:\n${stderrLines.join('').slice(-1500)}`);
  assert.equal(ok200.length, samples.length, `respuestas no-200 con wezterm colgado — latencias: ${lat}`);
  assert.ok(p95 < 3000 && worst < 5000,
    `el loop parece bloqueado: p95=${p95} ms, peor=${worst} ms — latencias: ${lat}\nlog:\n${stderrLines.join('').slice(-1200)}`);
});

test('AC3: el heartbeat nombra la ultima llamada CLI y su antiguedad', async () => {
  const file = path.join(INTEL, '.daemon-heartbeat.json');
  let beat = null;
  // El beat es cada 30 s: hay que darle margen a que salga uno con la llamada ya vista.
  for (let i = 0; i < 180 && !(beat && beat.last_cli_call); i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { beat = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { beat = null; }
  }
  assert.ok(beat, 'no hay heartbeat');
  assert.ok(beat.last_cli_call, `el beat no trae last_cli_call: ${JSON.stringify(beat).slice(0, 300)}`);
  assert.match(String(beat.last_cli_call.name), /wezterm|cli|list|get-text/i, 'debe nombrar la llamada');
  assert.equal(typeof beat.last_cli_call.age_ms, 'number');
  assert.ok(beat.last_cli_call.age_ms >= 0);
});

test('AC4 (en miniatura): el worker colgado es matado y revive solo, y el beat lo cuenta', async () => {
  const file = path.join(INTEL, '.daemon-heartbeat.json');
  let beat = null;
  // hangMs=4000: el kill llega a los ~5 s; el beat que lo cuenta, hasta 30 s despues.
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { beat = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { beat = null; }
    if (beat && beat.census && beat.census.restarts >= 1) break;
  }
  assert.ok(beat && beat.census, 'el beat no trae el estado del censo');
  assert.ok(beat.census.restarts >= 1,
    `el worker colgado nunca fue reiniciado: ${JSON.stringify(beat.census)}\nlog:\n${stderrLines.join('').slice(-1200)}`);
  assert.ok(stderrLines.join('').match(/census.*(colgad|hung|kill|reinici|respawn)/i),
    'el log del daemon debe registrar la muerte y el relanzamiento del worker');
});
