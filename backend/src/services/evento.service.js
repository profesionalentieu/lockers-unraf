'use strict';
/**
 * Bitacora de NEGOCIO: decisiones y cambios de estado que no son fisicos.
 * Lo fisico (pulsos, puerta, faltantes) va a logs_auditoria, la tabla que
 * pide la especificacion (ver auditoria.service.js).
 *
 * El panel muestra las dos mezcladas por fecha (ver feed()).
 */
const { db } = require('../config/database');
const reloj = require('../utils/reloj');

const TIPOS = {
  SOLICITUD: 'SOLICITUD',
  RESERVA_AUTOMATICA: 'RESERVA_AUTOMATICA',
  SOLICITUD_APROBADA: 'SOLICITUD_APROBADA',
  SOLICITUD_RECHAZADA: 'SOLICITUD_RECHAZADA',
  RESERVA_CANCELADA: 'RESERVA_CANCELADA',
  NO_SHOW: 'NO_SHOW',
  RETIRO: 'RETIRO',
  DEVOLUCION_ESTANDAR: 'DEVOLUCION_ESTANDAR',
  DEVOLUCION_CRITICA: 'DEVOLUCION_CRITICA',
  BUFFER_LIBERADO: 'BUFFER_LIBERADO',
  AUDITORIA_OK: 'AUDITORIA_OK',
  AUDITORIA_CON_DIFERENCIA: 'AUDITORIA_CON_DIFERENCIA',
  MORA: 'MORA',
  SANCION: 'SANCION',
  REHABILITACION: 'REHABILITACION',
  REASIGNACION: 'REASIGNACION',
  SIN_STOCK_RESPALDO: 'SIN_STOCK_RESPALDO',
  ENTREGA_VENTANILLA: 'ENTREGA_VENTANILLA',
  DEVOLUCION_VENTANILLA: 'DEVOLUCION_VENTANILLA',
  APERTURA_EMERGENCIA: 'APERTURA_EMERGENCIA',
  APERTURA_SIN_OPERACION: 'APERTURA_SIN_OPERACION',
  INVENTARIO_ACTUALIZADO: 'INVENTARIO_ACTUALIZADO',
  COMANDO_CONFIRMADO: 'COMANDO_CONFIRMADO',
  COMANDO_FALLIDO: 'COMANDO_FALLIDO',
  PUERTA_TRABADA: 'PUERTA_TRABADA',
};

function registrar(tipo, { lockerId = null, prestamoId = null, detalle = null, actor = null } = {}) {
  db.prepare(
    `INSERT INTO eventos (locker_id, prestamo_id, tipo, detalle, actor, creado_en)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(lockerId, prestamoId, tipo, detalle, actor, reloj.ahora());
}

/**
 * Feed unificado para el panel: bitacora de negocio + trazabilidad fisica,
 * ordenadas por fecha.
 */
function feed(limite = 40) {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT 'negocio' AS origen, id, tipo, detalle, actor, creado_en, prestamo_id, locker_id
         FROM eventos
         UNION ALL
         SELECT 'fisico' AS origen, id, evento AS tipo,
                TRIM(COALESCE(detalle_reporte, '') ||
                     CASE WHEN ultimo_responsable_previo IS NOT NULL
                          THEN ' · ultimo cierre previo: ' || ultimo_responsable_previo ELSE '' END) AS detalle,
                legajo_usuario AS actor, timestamp AS creado_en, prestamo_id, locker_id
         FROM logs_auditoria
       )
       ORDER BY creado_en DESC, id DESC
       LIMIT ?`
    )
    .all(limite);
}

module.exports = { TIPOS, registrar, feed };
