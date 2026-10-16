'use strict';
/**
 * Endpoints de la puerta: lo que usa la pantalla que abre el QR pegado en
 * cada locker (http://IP_SERVIDOR:3000/locker/A-01).
 *
 * El codigo de operacion ES la credencial frente a la puerta: no se pide
 * legajo ni PIN. Por eso hay un limite de intentos fallidos por IP: con
 * 6 digitos y sin limite, probar codigos seria cuestion de paciencia.
 */
const QRCode = require('qrcode');
const env = require('../config/env');
const { ErrorNegocio } = require('../utils/errores');
const lockers = require('../services/locker.service');
const operaciones = require('../services/operacion.service');
const { tokenOperacion } = require('./usuario.controller');

/* ---------- Limite de intentos fallidos ---------- */
const fallos = new Map();   // ip -> [timestamps]

function controlarIntentos(ip) {
  const ventana = env.reglas.accesoVentanaSeg * 1000;
  const recientes = (fallos.get(ip) || []).filter((t) => Date.now() - t < ventana);
  fallos.set(ip, recientes);
  if (recientes.length >= env.reglas.accesoIntentosMax)
    throw new ErrorNegocio('Demasiados códigos incorrectos. Esperá unos minutos o acercate a Alumnado.', 429);
}
const anotarFallo = (ip) => fallos.set(ip, [...(fallos.get(ip) || []), Date.now()]);

/** Lo minimo que se muestra de un locker a alguien sin sesion. */
const publico = (l) => ({
  id: l.id,
  descripcionItem: l.descripcionItem,
  categoria: l.categoria,
  ubicacion: l.nodo.ubicacion,
  estadoPuerta: l.estadoPuerta,
  fueraDeServicio: l.estado === 'ERROR',
  ocupado: Boolean(l.operacion),
});

/** GET /api/lockers -> lista publica (la usa la hoja de QR para imprimir) */
const listar = (req, res) => res.json({ lockers: lockers.listar().map(publico) });

/** GET /api/lockers/:id */
function ver(req, res) {
  const locker = lockers.obtener(req.params.id);
  if (!locker) return res.status(404).json({ error: 'El locker no existe' });
  res.json({ locker: publico(locker) });
}

/**
 * POST /api/lockers/:id/acceso  { codigo }
 * Valida el codigo contra ESTE locker y arranca retiro o devolucion.
 * Responde 202: la puerta todavia no se abrio, la orden va por radio.
 */
function acceso(req, res, next) {
  const ip = req.ip;
  try {
    controlarIntentos(ip);
    const operacion = operaciones.accesoConCodigo(req.params.id, req.body?.codigo);
    fallos.delete(ip);
    res.status(202).json({ operacion, token: tokenOperacion(operacion, null) });
  } catch (e) {
    if (e.codigoIncorrecto) anotarFallo(ip);
    next(e);
  }
}

/**
 * GET /api/lockers/:id/qr.svg?base=http://192.168.0.10:3000
 * QR para imprimir y pegar en la puerta. La base sale del parametro, de
 * URL_PUBLICA o del Host de la peticion, en ese orden.
 */
async function qr(req, res, next) {
  try {
    const locker = lockers.obtener(req.params.id);
    if (!locker) return res.status(404).json({ error: 'El locker no existe' });
    let base = env.urlPublica || `${req.protocol}://${req.get('host')}`;
    if (req.query.base) {
      const url = new URL(String(req.query.base));
      if (!['http:', 'https:'].includes(url.protocol)) throw new ErrorNegocio('La base tiene que ser http o https', 400);
      base = url.origin;
    }
    const svg = await QRCode.toString(`${base}/locker/${locker.id}`, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#12302C', light: '#FFFFFF' },
    });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    if (e instanceof TypeError) return next(new ErrorNegocio('La base no es una URL válida', 400));
    next(e);
  }
}

module.exports = { listar, ver, acceso, qr };
