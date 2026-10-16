'use strict';
/**
 * Cola de ordenes hacia los nodos.
 *
 * Por que una COLA y no una llamada directa al hardware:
 * La radio no garantiza la entrega: las tramas se pierden. Si el backend
 * intentara "abrir y esperar", la peticion HTTP quedaria colgada cada vez
 * que eso pasa. En su lugar:
 *
 *   1. Se valida el codigo   -> se ENCOLA un comando ABRIR (pendiente) con
 *                               la duracion del pulso (15 000 ms)
 *   2. El gateway lo toma    -> 'enviado'
 *   3. El nodo responde ACK  -> 'confirmado': el solenoide quedo energizado
 *   4. Sin ACK a tiempo      -> reintento; a los N intentos 'fallido'
 *
 * Una orden que no se entrego en COMANDO_VIGENCIA_SEG se descarta: un ABRIR
 * que llega tres minutos tarde destraba una puerta sin nadie adelante.
 */
const EventEmitter = require('events');
const { db } = require('../config/database');
const env = require('../config/env');
const reloj = require('../utils/reloj');
const hub = require('../realtime/hub');
const eventos = require('./evento.service');

/** Otros servicios se enteran de ACKs y fallas sin importar este modulo al reves. */
const avisos = new EventEmitter();

/**
 * Encola una orden de apertura.
 * @returns {object} comando creado
 */
function encolarApertura(lockerId, { origen, solicitadoPor, motivo = 'RETIRO', prestamoId = null }) {
  const duracionMs = Math.round(env.reglas.pulsoAperturaSeg * 1000);
  const info = db
    .prepare(
      `INSERT INTO comandos
         (locker_id, prestamo_id, tipo, motivo, duracion_ms, origen, solicitado_por, estado, creado_en)
       VALUES (?, ?, 'ABRIR', ?, ?, ?, ?, 'pendiente', ?)`
    )
    .run(lockerId, prestamoId, motivo, duracionMs, origen, solicitadoPor, reloj.ahora());

  const comando = obtener(info.lastInsertRowid);

  // Push inmediato al gateway si esta conectado por WebSocket:
  // le ahorra hasta un ciclo de polling completo.
  hub.emitir('comando.nuevo', paraGateway(comando), ['gateway']);
  return comando;
}

const SQL_COMANDO = `
  SELECT co.*, l.bit_registro, n.codigo AS nodo
  FROM comandos co
  JOIN lockers l    ON l.id = co.locker_id
  LEFT JOIN nodos n ON n.id = l.nodo_id`;

const obtener = (id) => db.prepare(`${SQL_COMANDO} WHERE co.id = ?`).get(id);

/**
 * Formato compacto que consume el gateway y viaja por radio.
 * `ms` es la duracion del pulso: el nodo mantiene el solenoide energizado
 * ese tiempo y despues corta, para proteger la bobina.
 */
const paraGateway = (c) => ({
  id: c.id,
  nodo: c.nodo,
  bit: c.bit_registro,       // que salida pulsar
  accion: c.tipo,            // 'ABRIR' | 'PING'
  ms: c.duracion_ms,         // 15000 por especificacion
  motivo: c.motivo,          // RETIRO | DEVOLUCION | EMERGENCIA (solo para logs)
  locker: c.locker_id,
  casillero: c.locker_id,    // nombre viejo del campo: el firmware v2 lo imprime
});

/** Comandos que el gateway todavia debe transmitir (pendientes o sin ACK). */
function pendientes(limite = 10) {
  descartarViejos();
  const limiteReintento = reloj.iso(reloj.ahoraMs() - env.reglas.comandoTimeoutSeg * 1000);
  return db
    .prepare(
      `${SQL_COMANDO}
       WHERE co.estado = 'pendiente'
          OR (co.estado = 'enviado' AND co.enviado_en < ? AND co.intentos < ?)
       ORDER BY co.creado_en ASC
       LIMIT ?`
    )
    .all(limiteReintento, env.reglas.comandoMaxIntentos, limite)
    .map(paraGateway);
}

/** El gateway tomo los comandos: pasan a 'enviado' y suman un intento. */
function marcarEnviados(ids) {
  if (!ids.length) return;
  const stmt = db.prepare(
    `UPDATE comandos SET estado = 'enviado', enviado_en = ?, intentos = intentos + 1 WHERE id = ?`
  );
  const tx = db.transaction((lista) => lista.forEach((id) => stmt.run(reloj.ahora(), id)));
  tx(ids);
}

/** ACK del nodo: el solenoide se energizo (o no). */
function confirmar(id, { ok = true, detalle = null } = {}) {
  const comando = obtener(id);
  if (!comando) return null;
  if (comando.estado === 'confirmado' || comando.estado === 'fallido') return comando; // ACK repetido

  db.prepare(`UPDATE comandos SET estado = ?, confirmado_en = ?, detalle = ? WHERE id = ?`)
    .run(ok ? 'confirmado' : 'fallido', reloj.ahora(), detalle, id);

  eventos.registrar(ok ? eventos.TIPOS.COMANDO_CONFIRMADO : eventos.TIPOS.COMANDO_FALLIDO, {
    lockerId: comando.locker_id,
    prestamoId: comando.prestamo_id,
    detalle: detalle || `comando #${id} (${comando.motivo})`,
    actor: 'gateway',
  });

  const actualizado = obtener(id);
  avisos.emit(ok ? 'confirmado' : 'fallido', actualizado);
  return actualizado;
}

/** Ordenes que nunca salieron y ya son peligrosas de entregar. */
function descartarViejos() {
  const limite = reloj.iso(reloj.ahoraMs() - env.reglas.comandoVigenciaSeg * 1000);
  const viejos = db
    .prepare(`SELECT id FROM comandos WHERE estado = 'pendiente' AND creado_en < ?`)
    .all(limite);
  for (const c of viejos) confirmar(c.id, { ok: false, detalle: 'Vencido: el gateway no lo tomo a tiempo' });
}

/** Watchdog: comandos que agotaron los reintentos sin ACK. */
function caducarVencidos() {
  descartarViejos();
  const limite = reloj.iso(reloj.ahoraMs() - env.reglas.comandoTimeoutSeg * 1000);
  const vencidos = db
    .prepare(
      `SELECT id FROM comandos WHERE estado = 'enviado' AND enviado_en < ? AND intentos >= ?`
    )
    .all(limite, env.reglas.comandoMaxIntentos);
  for (const c of vencidos) confirmar(c.id, { ok: false, detalle: 'Sin ACK del nodo tras agotar reintentos' });
  return vencidos;
}

module.exports = {
  avisos, encolarApertura, obtener, paraGateway, pendientes, marcarEnviados, confirmar, caducarVencidos,
};
