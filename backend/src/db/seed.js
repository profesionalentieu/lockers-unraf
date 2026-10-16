'use strict';
/**
 * Carga inicial del panol: 1 nodo, 4 lockers con material, la cuenta de
 * Alumnado y personas de prueba.
 *
 *   npm run seed
 *
 * Los PIN se guardan hasheados (pin_hash): por eso las credenciales de
 * prueba se imprimen aca y en `npm run verificar`, pero no se pueden leer
 * de la base.
 */
const { db, inicializarEsquema, ahora } = require('../config/database');
const { hashear } = require('../services/usuario.service');
const log = require('../utils/logger');

inicializarEsquema();

const PERSONAS = [
  ['alumnado', 'Mesa de Alumnado', 'admin', 'unraf2025'],
  ['10234', 'Bertola, Juan', 'alumno', '4821'],
  ['10235', 'Gimenez, Lucia', 'alumno', '7390'],
  ['20011', 'Ing. Sosa, Martin', 'docente', '1145'],
  ['20012', 'Lic. Ferrero, Ana', 'docente', '2468'],
];

const LOCKERS = [
  // id,    bit, descripcion,                categoria,      capacidad, stock
  ['A-01', 0, 'Notebook Lenovo 14"', 'Informática', 25, 25],
  ['A-02', 1, 'Zapatilla 5 tomas 5 m', 'Electricidad', 10, 10],
  ['A-03', 2, 'Fibrón para pizarra', 'Aula', 50, 50],
  ['A-04', 3, 'Kit Arduino UNO', 'Electrónica', 12, 12],
];

const cargar = db.transaction(() => {
  // --- Nodo del prototipo (la placa ESP32 XIAO del gabinete) ---
  db.prepare(
    `INSERT OR IGNORE INTO nodos (codigo, ubicacion, ultimo_contacto) VALUES ('NODO-A', 'Pañol - Planta baja', ?)`
  ).run(ahora());
  const nodo = db.prepare(`SELECT id FROM nodos WHERE codigo = 'NODO-A'`).get();

  // --- 4 lockers: cada uno una salida del nodo y un tipo de material ---
  const insLocker = db.prepare(
    `INSERT OR IGNORE INTO lockers
       (id, descripcion_item, categoria, capacidad_maxima, stock_actual_fisico, estado_puerta, nodo_id, bit_registro)
     VALUES (?, ?, ?, ?, ?, 'CERRADO', ?, ?)`
  );
  for (const [id, bit, descripcion, categoria, capacidad, stock] of LOCKERS)
    insLocker.run(id, descripcion, categoria, capacidad, stock, nodo.id, bit);

  // --- Padron ---
  const insUsuario = db.prepare(
    `INSERT OR IGNORE INTO usuarios (legajo, nombre, rol, pin_hash, sancionado, activo) VALUES (?, ?, ?, ?, 0, 1)`
  );
  for (const [legajo, nombre, rol, pin] of PERSONAS) insUsuario.run(legajo, nombre, rol, hashear(pin));
});

cargar();

log.info('Pañol cargado:');
log.info('  Alumnado -> usuario: alumnado / clave: unraf2025');
log.info('  Alumno   -> legajo: 10234 / PIN: 4821   (1 unidad, solo hoy, siempre con aprobación)');
log.info('  Alumno   -> legajo: 10235 / PIN: 7390');
log.info('  Docente  -> legajo: 20011 / PIN: 1145   (hasta 7 días; aprobación si pide > 50%)');
log.info('  Docente  -> legajo: 20012 / PIN: 2468');
log.info('  A-01 25 notebooks | A-02 10 zapatillas | A-03 50 fibrones | A-04 12 kits Arduino');
