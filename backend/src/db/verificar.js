'use strict';
/**
 * Diagnostico de la base: responde "por que no puedo entrar".
 *
 *   npm run verificar
 *
 * Muestra donde esta la base, que version de esquema tiene, cuantos
 * registros hay en cada tabla y cuales son las credenciales cargadas.
 */
const { db, inicializarEsquema, RUTA_DB } = require('../config/database');
const fs = require('fs');

const linea = () => console.log('─'.repeat(64));

console.log('\n  DIAGNOSTICO DE LA BASE — Pañol UNRaf');
linea();

// --- 1. El archivo existe? ---
if (!fs.existsSync(RUTA_DB)) {
  console.log(`  La base NO existe todavia:\n    ${RUTA_DB}\n`);
  console.log('  Solucion:  npm run seed\n');
  process.exit(0);
}
const tamano = (fs.statSync(RUTA_DB).size / 1024).toFixed(1);
console.log(`  Archivo:  ${RUTA_DB}`);
console.log(`  Tamaño:   ${tamano} kB`);

// --- 2. Esquema al dia? ---
try {
  inicializarEsquema();
  console.log(`  Esquema:  v${db.prepare('PRAGMA user_version').get().user_version} (al dia)`);
} catch (e) {
  console.log(`  Esquema:  DESACTUALIZADO`);
  linea();
  console.log(e.message);
  process.exit(1);
}

// --- 3. Cuantos registros hay ---
linea();
const contar = (tabla) => {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n; }
  catch { return '—'; }
};
for (const tabla of ['usuarios', 'lockers', 'prestamos', 'logs_auditoria', 'comandos', 'eventos'])
  console.log(`  ${tabla.padEnd(16)} ${String(contar(tabla)).padStart(4)} registro(s)`);

// --- 4. Credenciales cargadas ---
// Los PIN estan hasheados (pin_hash): no se pueden leer de la base. Se
// muestran los legajos y, al lado, la clave que les asigna el seed.
const CLAVES_SEED = { alumnado: 'unraf2025', 10234: '4821', 10235: '7390', 20011: '1145', 20012: '2468' };
const gente = db.prepare(`SELECT legajo, nombre, rol, activo, sancionado FROM usuarios ORDER BY rol, legajo`).all();

linea();
if (!gente.length) {
  console.log('  NO HAY NINGUN USUARIO CARGADO.');
  console.log('  Por eso el login rechaza cualquier clave.\n');
  console.log('  Solucion:  npm run seed\n');
  process.exit(0);
}

const marca = (u) => `${u.activo ? '' : '  [INACTIVO]'}${u.sancionado ? '  [SANCIONADO]' : ''}`;
const clave = (u) => (CLAVES_SEED[u.legajo] ? `(seed: ${CLAVES_SEED[u.legajo]})` : '(PIN propio)');

console.log('  PANEL DE ALUMNADO   ->  http://localhost:3000/admin');
for (const u of gente.filter((x) => x.rol === 'admin'))
  console.log(`    usuario: ${u.legajo}   clave ${clave(u)}${marca(u)}`);

console.log('\n  APP DE USUARIOS     ->  http://localhost:3000/');
for (const u of gente.filter((x) => x.rol !== 'admin'))
  console.log(`    legajo: ${u.legajo}   PIN ${clave(u).padEnd(14)} ${u.rol.padEnd(8)} ${u.nombre}${marca(u)}`);

linea();
console.log('  Si las credenciales estan y aun asi no entras:');
console.log('    · Entra por http://localhost:3000  (NO abriendo el .html con doble clic)');
console.log('    · Revisa que el servidor este corriendo (npm start)');
console.log('    · Ojo con mayusculas y espacios al copiar y pegar\n');
