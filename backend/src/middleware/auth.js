'use strict';
/**
 * Autenticacion. Cuatro identidades distintas:
 *
 *   admin      -> Mesa de Alumnado (usuario 'alumnado' + clave). JWT rol 'admin'.
 *   usuario    -> alumno o docente (legajo + PIN). JWT rol 'usuario' + legajo + rolUsuario.
 *   operacion  -> la pantalla del locker despues de validar un codigo. JWT corto
 *                 (20 min) atado a UN prestamo, UN locker y UN tipo de operacion.
 *                 Sirve para reintentar la apertura y reportar un faltante sin
 *                 pedir legajo y PIN frente a la puerta.
 *   gateway    -> el puente de radio o la placa WiFi. API key fija en header.
 *
 * Las reglas de "es tuyo" se validan en los servicios, nunca en el frontend.
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const firmarToken = (payload, expiracion) => jwt.sign(payload, env.jwt.secreto, { expiresIn: expiracion });

/** Extrae y verifica el Bearer token. */
function verificarToken(req) {
  const cabecera = req.headers.authorization || '';
  if (!cabecera.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(cabecera.slice(7), env.jwt.secreto);
  } catch {
    return null;
  }
}

/** Exige un JWT con alguno de los roles indicados. */
const requiereRol = (...roles) => (req, res, next) => {
  const payload = verificarToken(req);
  if (!payload) return res.status(401).json({ error: 'Sesión vencida o inválida: volvé a entrar' });
  if (!roles.includes(payload.rol))
    return res.status(403).json({ error: 'No tenés permiso para esta operación' });
  req.usuario = payload;
  next();
};

/** Exige la API key del gateway. */
const requiereGateway = (req, res, next) => {
  if (req.headers['x-api-key'] !== env.gatewayApiKey)
    return res.status(401).json({ error: 'API key del gateway inválida' });
  next();
};

module.exports = { firmarToken, verificarToken, requiereRol, requiereGateway };
