'use strict';
/**
 * Telemetria entrante desde los nodos (via gateway o WiFi directo).
 *
 * El final de carrera (microswitch) de cada puerta es la unica fuente de
 * verdad sobre el estado fisico. El backend nunca "asume" que una puerta se
 * abrio porque mando el pulso: espera el reporte del switch, y cada CAMBIO
 * se lo pasa a operacion.service, que decide que significa para el prestamo
 * (retiro terminado, devolucion terminada, apertura no autorizada...).
 */
const { db } = require('../config/database');
const reloj = require('../utils/reloj');
const lockers = require('./locker.service');
const operaciones = require('./operacion.service');

/**
 * Procesa una lectura de puerta.
 * @param {{nodo:string, bit:number, puertaAbierta:boolean, rssi?:number}} lectura
 */
function registrarPuerta({ nodo, bit, puertaAbierta, rssi = null }) {
  const antes = db
    .prepare(
      `SELECT l.* FROM lockers l JOIN nodos n ON n.id = l.nodo_id
       WHERE n.codigo = ? AND l.bit_registro = ?`
    )
    .get(nodo, bit);
  if (!antes) return null;

  const estadoNuevo = puertaAbierta ? 'ABIERTO' : 'CERRADO';
  const cambio = antes.estado_puerta !== estadoNuevo;
  const ahora = reloj.ahora();

  db.prepare(
    `UPDATE lockers
     SET estado_puerta = ?,
         abierta_desde = CASE WHEN ? = 'ABIERTO' THEN COALESCE(abierta_desde, ?) ELSE NULL END,
         alerta_puerta_enviada = CASE WHEN ? = 1 THEN 0 ELSE alerta_puerta_enviada END,
         ultima_telemetria = ?,
         -- Al cerrarse se limpia una eventual marca de puerta trabada
         estado_operativo = CASE WHEN ? = 'CERRADO' AND detalle_error LIKE 'Puerta abierta%' THEN 'ok' ELSE estado_operativo END,
         detalle_error    = CASE WHEN ? = 'CERRADO' AND detalle_error LIKE 'Puerta abierta%' THEN NULL ELSE detalle_error END
     WHERE id = ?`
  ).run(estadoNuevo, estadoNuevo, ahora, cambio ? 1 : 0, ahora, estadoNuevo, estadoNuevo, antes.id);

  if (rssi !== null) {
    db.prepare(`UPDATE nodos SET rssi = ?, ultimo_contacto = ? WHERE codigo = ?`).run(rssi, ahora, nodo);
  }

  if (cambio) operaciones.alCambiarPuerta(antes, puertaAbierta);

  lockers.notificar(antes.id);
  return lockers.obtener(antes.id);
}

/** Heartbeat del nodo: mantiene vivo el indicador de enlace. */
function heartbeat({ nodo, rssi = null, bateriaMv = null }) {
  db.prepare(
    `UPDATE nodos
     SET ultimo_contacto = ?, rssi = COALESCE(?, rssi), bateria_mv = COALESCE(?, bateria_mv)
     WHERE codigo = ?`
  ).run(reloj.ahora(), rssi, bateriaMv, nodo);
}

module.exports = { registrarPuerta, heartbeat };
