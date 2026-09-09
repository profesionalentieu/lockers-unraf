'use strict';
/** Endpoints que consume la WebApp de alumnos y docentes. */
const casilleros = require('../services/casillero.service');
const prestamos = require('../services/prestamo.service');
const comandos = require('../services/comando.service');

/**
 * GET /api/usuario/catalogo
 * Que material hay y cuanto queda disponible ahora mismo.
 */
function catalogo(req, res) {
  const items = casilleros.catalogo().map((casillero) => ({
    casilleroId: casillero.id,
    casillero: casillero.codigo,
    ubicacion: casillero.nodo.ubicacion,
    item: casillero.item,
    disponible: casillero.inventario.disponible,
    total: casillero.inventario.total,
    stockBajo: casillero.inventario.stockBajo,
    estado: casillero.estado,
    // El frontend deshabilita el boton con esto, pero la validacion real
    // esta en el servidor: nunca confiamos en que el boton estaba gris.
    sePuedePedir:
      casillero.inventario.disponible > 0 && casillero.estado !== casilleros.ESTADOS.ERROR,
  }));

  res.json({
    items,
    limitePorRetiro: prestamos.LIMITE_POR_RETIRO[req.usuario.rolUsuario] ?? 5,
  });
}

/**
 * POST /api/usuario/prestamos   { casilleroId, cantidad }
 * Registra la SOLICITUD y reserva el stock. No abre ningun casillero:
 * eso ocurre cuando Alumnado aprueba.
 * Responde 202 con el prestamo en estado 'pendiente'.
 */
function solicitar(req, res, next) {
  try {
    const { casilleroId, cantidad } = req.body || {};
    const resultado = prestamos.solicitar({
      legajo: req.usuario.legajo,
      casilleroId: Number(casilleroId),
      cantidad: Number(cantidad),
    });
    res.status(202).json(resultado);
  } catch (e) {
    next(e);
  }
}

/**
 * GET /api/usuario/prestamos/:id
 * Seguimiento de una solicitud mientras espera aprobacion. El aviso real
 * llega por WebSocket; esto es el respaldo por si el socket se corto.
 */
function estadoPrestamo(req, res) {
  const prestamo = prestamos.obtener(Number(req.params.id));
  if (!prestamo) return res.status(404).json({ error: 'La solicitud no existe' });
  if (prestamo.usuario.legajo !== req.usuario.legajo)
    return res.status(403).json({ error: 'Esa solicitud no es tuya' });
  res.json({ prestamo });
}

/**
 * POST /api/usuario/prestamos/:id/devolucion   { cantidad? }
 *
 * Se mantiene por compatibilidad, pero NO es el camino normal: la devolucion
 * se hace con el segundo uso del codigo, parado frente al locker. Este
 * endpoint solo registra la devolucion sin abrir nada, para el caso de que la
 * persona ya haya guardado el material y la puerta se haya cerrado.
 */
function devolver(req, res, next) {
  try {
    const resultado = prestamos.devolver(Number(req.params.id), {
      legajo: req.usuario.legajo,
      cantidad: req.body?.cantidad != null ? Number(req.body.cantidad) : null,
    });
    res.status(202).json(resultado);
  } catch (e) {
    next(e);
  }
}

/**
 * GET /api/usuario/prestamos -> separado por etapa del circuito
 *   pendientes -> esperando que Alumnado apruebe
 *   aprobados  -> ya tienen codigo: hay que ir al locker a retirar
 *   activos    -> material en su poder, el codigo sirve una vez mas
 */
function misPrestamos(req, res) {
  const lista = prestamos.porUsuario(req.usuario.legajo);
  res.json({
    pendientes: lista.filter((p) => p.estado === 'pendiente'),
    aprobados: lista.filter((p) => p.estado === 'aprobado'),
    activos: lista.filter((p) => p.estado === 'activo'),
    historial: lista.filter((p) => ['devuelto', 'rechazado', 'caducado'].includes(p.estado)),
  });
}

/** GET /api/usuario/comandos/:id -> seguimiento de la apertura */
function estadoComando(req, res) {
  const comando = comandos.obtener(Number(req.params.id));
  if (!comando) return res.status(404).json({ error: 'El comando no existe' });
  if (comando.origen === 'usuario' && comando.solicitado_por !== req.usuario.legajo)
    return res.status(403).json({ error: 'Ese comando no es tuyo' });

  res.json({
    id: comando.id,
    estado: comando.estado,
    motivo: comando.motivo,
    intentos: comando.intentos,
    detalle: comando.detalle,
    casillero: comando.casillero_codigo,
  });
}

module.exports = { catalogo, solicitar, devolver, misPrestamos, estadoPrestamo, estadoComando };
