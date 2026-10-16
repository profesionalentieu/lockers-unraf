'use strict';
/**
 * Endpoints de una operacion en curso frente a la puerta. Todos exigen el
 * token corto (rol 'operacion') que entrega /lockers/:id/acceso o
 * /usuario/reservas/:id/devolucion: esta atado a UN prestamo y UN locker.
 */
const operaciones = require('../services/operacion.service');

/** GET /api/operacion -> fase actual (respaldo del WebSocket) */
function estado(req, res) {
  const { lockerId, prestamoId, tipo } = req.usuario;
  const datos = operaciones.estado(lockerId, prestamoId, tipo);
  if (!datos) return res.status(404).json({ error: 'La operación ya no existe' });
  res.json({ operacion: datos });
}

/** POST /api/operacion/reintentar -> nuevo pulso de 15 s, sin penalizar la reserva */
function reintentar(req, res, next) {
  try {
    res.status(202).json({ operacion: operaciones.reintentar(req.usuario.prestamoId, req.usuario.tipo) });
  } catch (e) { next(e); }
}

/** POST /api/operacion/incidencia  { detalle } -> "Reportar Faltante/Incidencia" */
function reportar(req, res, next) {
  try {
    res.status(201).json(operaciones.reportarIncidencia(req.usuario.prestamoId, { detalle: req.body?.detalle }));
  } catch (e) { next(e); }
}

module.exports = { estado, reintentar, reportar };
