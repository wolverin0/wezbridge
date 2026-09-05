'use strict';
/**
 * wezterm-hang-if-cli.cjs — preload (NODE_OPTIONS --require) que convierte una
 * COPIA de node.exe en un wezterm.exe COLGADO: cuando el proceso fue invocado
 * como `wezterm cli ...` se bloquea para siempre con el proceso vivo y stdout
 * abierto (Atomics.wait en el hilo principal), que es la firma exacta del mux
 * mudo del T-0321. Para cualquier otro proceso node que herede NODE_OPTIONS
 * (el daemon bajo prueba, su worker) es un no-op.
 *
 * Por que una copia de node.exe y no un .cmd: execFileSync sin shell no puede
 * lanzar .cmd/.cjs en Windows; necesita un ejecutable real.
 */
// Node RESUELVE argv[1] a ruta absoluta antes de correr los preloads
// (`wezterm.exe cli ...` llega como 'G:\...\wezbridge\cli'), asi que se compara
// el basename, no la palabra suelta.
const path = require('node:path');
const argv = process.argv.slice(1);
if (argv.some((a) => path.basename(String(a)) === 'cli')) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0); // nunca vuelve
}
