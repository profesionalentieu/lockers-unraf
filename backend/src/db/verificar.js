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
for (const tabla of ['administrativos', 'usuarios', 'items', 'casilleros', 'prestamos', 'comandos'])
  console.log(`  ${tabla.padEnd(16)} ${String(contar(tabla)).padStart(4)} registro(s)`);

// --- 4. Credenciales cargadas ---
const admins = db.prepare(`SELECT usuario, nombre, activo FROM administrativos`).all();
const gente = db.prepare(`SELECT legajo, nombre, pin, rol, activo FROM usuarios`).all();

linea();
if (!admins.length && !gente.length) {
  console.log('  NO HAY NINGUN USUARIO CARGADO.');
  console.log('  Por eso el login rechaza cualquier clave.\n');
  console.log('  Solucion:  npm run seed\n');
  process.exit(0);
}

console.log('  PANEL DE ALUMNADO   ->  http://localhost:3000/admin');
for (const a of admins)
  console.log(`    usuario: ${a.usuario}   (clave del seed: unraf2025)${a.activo ? '' : '  [INACTIVO]'}`);

console.log('\n  APP DE USUARIOS     ->  http://localhost:3000/');
for (const u of gente)
  console.log(`    legajo: ${u.legajo}   PIN: ${u.pin}   ${u.rol.padEnd(8)} ${u.nombre}${u.activo ? '' : '  [INACTIVO]'}`);

linea();
console.log('  Si las credenciales estan y aun asi no entras:');
console.log('    · Entra por http://localhost:3000  (NO abriendo el .html con doble clic)');
console.log('    · Revisa que el servidor este corriendo (npm start)');
console.log('    · Ojo con mayusculas y espacios al copiar y pegar\n');
