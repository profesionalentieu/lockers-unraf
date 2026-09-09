'use strict';
/**
 * Endpoints publicos: los consume la pagina a la que lleva el QR pegado en
 * cada locker. NO llevan JWT, porque la persona esta parada frente al
 * casillero con el celular y no tiene por que loguearse.
 *
 * La proteccion es doble:
 *   · el codigo se valida junto con el casillero que viene en la URL del QR
 *   · hay limite de intentos fallidos por casillero, con bloqueo temporal
 */
const { db } = require('../config/database');
const prestamos = require('../services/prestamo.service');

/** Identificador del cliente para el control de intentos. */
const origenDe = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'desconocido';

/**
 * GET /api/publico/casillero/:codigo
 * Datos minimos para que la pagina muestre a que locker esta apuntando.
 * No revela nada de quien tiene material ni de los codigos vigentes.
 */
function infoCasillero(req, res) {
  const fila = db
    .prepare(
      `SELECT c.codigo, c.estado_puerta, c.estado_operativo, n.ubicacion,
              i.nombre AS item
       FROM casilleros c
       JOIN nodos n      ON n.id = c.nodo_id
       LEFT JOIN items i ON i.id = c.item_id
       WHERE c.codigo = ?`
    )
    .get(String(req.params.codigo).trim().toUpperCase());

  if (!fila) return res.status(404).json({ error: 'Ese casillero no existe' });

  res.json({
    casillero: fila.codigo,
    ubicacion: fila.ubicacion,
    item: fila.item,
    puertaAbierta: fila.estado_puerta === 'abierta',
    fueraDeServicio: fila.estado_operativo === 'error',
  });
}

/**
 * POST /api/publico/abrir   { casillero, codigo }
 * Primer uso del codigo -> retira. Segundo uso -> devuelve.
 * Responde 202: la puerta se abre un instante despues.
 */
function abrir(req, res, next) {
  try {
    const { casillero, codigo } = req.body || {};
    if (!casillero) return res.status(400).json({ error: 'Falta el casillero' });

    const resultado = prestamos.usarCodigo(casillero, codigo, origenDe(req));
    res.status(202).json(resultado);
  } catch (e) {
    next(e);
  }
}

module.exports = { infoCasillero, abrir };
