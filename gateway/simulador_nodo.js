'use strict';
/**
 * SIMULADOR DE NODO (version Node.js) — el sistema completo sin hardware.
 *
 * Hace de gateway, de nodo Y de la persona frente a la puerta:
 *   1. Consulta las ordenes al backend real (GET /api/gateway/comandos).
 *   2. "Energiza" el solenoide el tiempo que pide la orden (ms = 15000) y
 *      manda el ACK apenas arranca el pulso.
 *   3. Simula a alguien que tira de la puerta a los 2-5 s (dentro del pulso),
 *      la deja abierta unos segundos y la cierra: el microswitch reporta
 *      ABIERTO y despues CERRADO, igual que el hardware.
 *
 * No necesita instalar NADA: usa el fetch que ya trae Node.
 * (simulador_nodo.py hace lo mismo para quien prefiera Python.)
 *
 * Uso, con el backend corriendo en otra terminal:
 *     node gateway/simulador_nodo.js
 *
 * Opciones para ensayar los escenarios de la especificacion:
 *     --no-abre A-02       nadie abre esa puerta: a los 15 s la pantalla ofrece
 *                          "Reintentar apertura" (Fase 2.4)
 *     --trabar A-03        esa puerta nunca cierra: alerta a los 45 s y ERROR a los 120 s
 *     --cierre 50          segundos que la puerta queda abierta (por defecto 8;
 *                          con mas de 45 dispara la alerta de puerta mal cerrada)
 *     --perder 30          descarta el 30% de las ordenes, como una radio real
 *     --backend http://192.168.0.10:3000
 */

const API_KEY = process.env.GATEWAY_API_KEY || 'gw-lora-unraf-2025';   // = GATEWAY_API_KEY del .env
const NODO = 'NODO-A';
const INTERVALO_POLL = 1000;            // ms entre consultas
const INTERVALO_HEARTBEAT = 30000;

// Mapa bit -> locker, igual que en el seed. Solo para los mensajes en pantalla.
const LOCKERS = { 0: 'A-01', 1: 'A-02', 2: 'A-03', 3: 'A-04' };

/* ---------- Argumentos ---------- */
function leerArgumentos(argv) {
  const o = { backend: 'http://localhost:3000', trabar: new Set(), noAbre: new Set(), perder: 0, cierre: 8 };
  const lista = (conjunto, i) => { while (argv[i + 1] && !argv[i + 1].startsWith('--')) conjunto.add(argv[++i].toUpperCase()); return i; };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backend') o.backend = argv[++i];
    else if (argv[i] === '--perder') o.perder = Number(argv[++i]) || 0;
    else if (argv[i] === '--cierre') o.cierre = Number(argv[++i]) || 8;
    else if (argv[i] === '--trabar') i = lista(o.trabar, i);
    else if (argv[i] === '--no-abre') i = lista(o.noAbre, i);
  }
  o.backend = o.backend.replace(/\/$/, '');
  return o;
}

const opciones = leerArgumentos(process.argv.slice(2));
const puertas = new Map();   // bit -> { abierta, temporizadores }
let ultimoHeartbeat = 0;

/* ---------- Helpers ---------- */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rssi = () => azar(-85, -55);
const hora = () => new Date().toLocaleTimeString('es-AR');
const cabeceras = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

async function enviar(ruta, cuerpo) {
  try {
    const r = await fetch(opciones.backend + ruta, { method: 'POST', headers: cabeceras, body: JSON.stringify(cuerpo) });
    if (r.status === 401) console.log('  ! API key rechazada: revisá GATEWAY_API_KEY');
  } catch (e) {
    console.log(`  ! no pude hablar con el backend: ${e.message}`);
  }
}

const reportarPuerta = (bit, abierta) =>
  enviar('/api/gateway/telemetria', { nodo: NODO, lecturas: [{ bit, puertaAbierta: abierta }], rssi: rssi() });

/* ---------- El circuito ---------- */
async function procesarComando(comando) {
  const locker = LOCKERS[comando.bit] ?? `bit ${comando.bit}`;
  const pulso = Math.min(Number(comando.ms) || 15000, 20000);

  if (azar(1, 100) <= opciones.perder) {
    console.log(`[${hora()}] ~ orden #${comando.id} (${locker}) PERDIDA en el aire: el backend reintenta`);
    return;
  }

  const puerta = puertas.get(comando.bit) || { abierta: false, timers: [] };
  puertas.set(comando.bit, puerta);

  // 1. El nodo energiza el solenoide y confirma (ACK = pulso en marcha)
  console.log(`[${hora()}] -> orden #${comando.id} ${locker} · ${comando.motivo} · solenoide ${pulso / 1000} s`);
  await enviar(`/api/gateway/comandos/${comando.id}/ack`, { ok: true, detalle: 'simulador' });
  puerta.timers.push(setTimeout(() => console.log(`[${hora()}]    ${locker}: fin del pulso, solenoide sin energía`), pulso));

  if (puerta.abierta) return;
  if (opciones.noAbre.has(locker)) {
    console.log(`[${hora()}]    ${locker}: nadie tira de la puerta (--no-abre)`);
    return;
  }

  // 2. La persona abre dentro del pulso...
  const abreEn = azar(2000, Math.min(5000, pulso - 1000));
  puerta.timers.push(setTimeout(async () => {
    puerta.abierta = true;
    await reportarPuerta(comando.bit, true);
    console.log(`[${hora()}] <- microswitch: ${locker} ABIERTO`);

    // 3. ...retira o deposita y cierra (salvo que este trabada a proposito)
    if (opciones.trabar.has(locker)) {
      console.log(`[${hora()}]    ${locker}: queda abierta (--trabar)`);
      return;
    }
    puerta.timers.push(setTimeout(async () => {
      puerta.abierta = false;
      await reportarPuerta(comando.bit, false);
      console.log(`[${hora()}] <- microswitch: ${locker} CERRADO`);
    }, opciones.cierre * 1000));
  }, abreEn));
}

async function heartbeat() {
  if (Date.now() - ultimoHeartbeat < INTERVALO_HEARTBEAT) return;
  ultimoHeartbeat = Date.now();
  await enviar('/api/gateway/heartbeat', { nodo: NODO, rssi: rssi(), bateriaMv: azar(3900, 4150) });
}

/* ---------- Bucle principal ---------- */
async function arrancar() {
  console.log(`Simulador de ${NODO} contra ${opciones.backend}`);
  if (opciones.noAbre.size) console.log(`  puertas que nadie abre: ${[...opciones.noAbre].join(', ')}`);
  if (opciones.trabar.size) console.log(`  puertas que quedan abiertas: ${[...opciones.trabar].join(', ')}`);
  if (opciones.perder) console.log(`  pérdida de órdenes simulada: ${opciones.perder}%`);
  console.log(`  la puerta queda abierta ${opciones.cierre} s antes de cerrarse`);
  console.log('Ctrl+C para salir.\n');

  // Al arrancar, el nodo real reporta las 4 puertas: todas cerradas.
  await enviar('/api/gateway/telemetria', {
    nodo: NODO, rssi: rssi(), lecturas: Object.keys(LOCKERS).map((bit) => ({ bit: Number(bit), puertaAbierta: false })),
  });

  for (;;) {
    try {
      const respuesta = await fetch(`${opciones.backend}/api/gateway/comandos`, { headers: cabeceras });
      const datos = await respuesta.json();
      for (const comando of datos.comandos ?? []) await procesarComando(comando);
      await heartbeat();
    } catch {
      console.log('  ! el backend no responde (¿npm start está corriendo?)');
    }
    await dormir(INTERVALO_POLL);
  }
}

process.on('SIGINT', () => { console.log('\nSimulador detenido.'); process.exit(0); });

arrancar();
