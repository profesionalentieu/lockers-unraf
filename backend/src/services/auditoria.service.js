'use strict';
/**
 * Trazabilidad FISICA (tabla logs_auditoria de la especificacion):
 * pulsos de apertura, puerta abierta/cerrada, reintentos, alertas de puerta
 * mal cerrada y reportes de faltante o dano.
 *
 * Es la que responde "quien fue el ultimo que cerro este locker", que es
 * justamente lo que hace falta cuando alguien abre y encuentra menos unidades.
 */
const { db } = require('../config/database');
const reloj = require('../utils/reloj');

const EVENTOS = {
  PULSO_APERTURA_RETIRO: 'PULSO_APERTURA_RETIRO',
  PUERTA_ABIERTA: 'PUERTA_ABIERTA',
  PUERTA_CERRADA: 'PUERTA_CERRADA',
  REINTENTO_APERTURA: 'REINTENTO_APERTURA',
  ALERTA_PUERTA_ABIERTA: 'ALERTA_PUERTA_ABIERTA',
  PULSO_APERTURA_DEVOLUCION: 'PULSO_APERTURA_DEVOLUCION',
  REPORTE_FALTANTE_O_DANO: 'REPORTE_FALTANTE_O_DANO',
};

/** Legajo que firma lo que pasa sin una persona identificada detras. */
const SIN_RESPONSABLE = 'sistema';

function registrar(evento, { lockerId, legajo, prestamoId = null, detalle = null, ultimoResponsable = null }) {
  const info = db
    .prepare(
      `INSERT INTO logs_auditoria
         (locker_id, legajo_usuario, prestamo_id, evento, detalle_reporte, ultimo_responsable_previo, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(lockerId, legajo || SIN_RESPONSABLE, prestamoId, evento, detalle, ultimoResponsable, reloj.ahora());
  return info.lastInsertRowid;
}

/**
 * Ultimo legajo que CERRO el locker antes de un momento dado, sin contar el
 * prestamo de quien reporta. Es el "presunto responsable" de un faltante.
 */
function ultimoCierrePrevio(lockerId, { antesDe = reloj.ahora(), excluirPrestamoId = null } = {}) {
  const fila = db
    .prepare(
      `SELECT l.legajo_usuario, l.prestamo_id, l.timestamp, u.nombre
       FROM logs_auditoria l
       LEFT JOIN usuarios u ON u.legajo = l.legajo_usuario
       WHERE l.locker_id = ? AND l.evento = 'PUERTA_CERRADA' AND l.timestamp <= ?
         AND (l.prestamo_id IS NULL OR l.prestamo_id IS NOT ?)
       ORDER BY l.id DESC LIMIT 1`
    )
    .get(lockerId, antesDe, excluirPrestamoId);
  return fila || null;
}

/** Reportes de faltante que Alumnado todavia no marco como revisados. */
const incidenciasPendientes = () =>
  db
    .prepare(
      `SELECT l.id, l.locker_id, l.legajo_usuario, l.prestamo_id, l.detalle_reporte,
              l.ultimo_responsable_previo, l.timestamp,
              u.nombre AS nombre_reporta,
              r.nombre AS nombre_responsable, r.sancionado AS responsable_sancionado
       FROM logs_auditoria l
       LEFT JOIN usuarios u ON u.legajo = l.legajo_usuario
       LEFT JOIN usuarios r ON r.legajo = l.ultimo_responsable_previo
       WHERE l.evento = 'REPORTE_FALTANTE_O_DANO' AND l.revisado = 0
       ORDER BY l.id DESC`
    )
    .all()
    .map((f) => ({
      id: f.id,
      lockerId: f.locker_id,
      prestamoId: f.prestamo_id,
      detalle: f.detalle_reporte,
      timestamp: f.timestamp,
      reporta: { legajo: f.legajo_usuario, nombre: f.nombre_reporta },
      presuntoResponsable: f.ultimo_responsable_previo
        ? {
            legajo: f.ultimo_responsable_previo,
            nombre: f.nombre_responsable,
            sancionado: Boolean(f.responsable_sancionado),
          }
        : null,
    }));

const obtenerIncidencia = (id) =>
  db.prepare(`SELECT * FROM logs_auditoria WHERE id = ? AND evento = 'REPORTE_FALTANTE_O_DANO'`).get(id);

const marcarRevisada = (id) =>
  db.prepare(`UPDATE logs_auditoria SET revisado = 1 WHERE id = ?`).run(id).changes;

/** Trazabilidad de un prestamo puntual (para el detalle en el panel). */
const dePrestamo = (prestamoId) =>
  db.prepare(`SELECT * FROM logs_auditoria WHERE prestamo_id = ? ORDER BY id`).all(prestamoId);

module.exports = {
  EVENTOS, SIN_RESPONSABLE,
  registrar, ultimoCierrePrevio, incidenciasPendientes, obtenerIncidencia, marcarRevisada, dePrestamo,
};
