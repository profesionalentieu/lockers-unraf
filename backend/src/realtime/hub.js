'use strict';
/**
 * Hub de tiempo real (WebSocket).
 *
 * Cuatro tipos de cliente se conectan aca:
 *   - admin      -> panel de Mesa de Alumnado: ve todo.
 *   - usuario    -> app de alumnos y docentes: solo lo suyo (por legajo).
 *   - operacion  -> pantalla del locker abierta desde el QR: solo la puerta
 *                   que esta operando (por locker), con el token corto que
 *                   recibio al validar el codigo.
 *   - gateway    -> el puente de radio: recibe las ordenes al instante.
 *
 * El hub NO tiene logica de negocio: solo reparte mensajes.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const log = require('../utils/logger');

let wss = null;

/** Mensaje estandar: { evento: 'locker.actualizado', datos: {...}, ts } */
function armarMensaje(evento, datos) {
  return JSON.stringify({ evento, datos, ts: new Date().toISOString() });
}

/**
 * Inicializa el servidor WebSocket sobre el mismo puerto HTTP.
 *   ws://host/ws?token=<jwt>          -> admin, usuario u operacion
 *   ws://host/ws?apiKey=<gatewayKey>  -> gateway de radio
 */
function iniciar(servidorHttp) {
  wss = new WebSocketServer({ server: servidorHttp, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const apiKey = url.searchParams.get('apiKey');

    if (apiKey && apiKey === env.gatewayApiKey) {
      socket.rol = 'gateway';
    } else if (token) {
      try {
        const payload = jwt.verify(token, env.jwt.secreto);
        socket.rol = payload.rol;            // 'admin' | 'usuario' | 'operacion'
        socket.legajo = payload.legajo || null;
        socket.lockerId = payload.lockerId || null;
        socket.prestamoId = payload.prestamoId || null;
      } catch {
        socket.close(4001, 'Token invalido');
        return;
      }
    } else {
      socket.close(4001, 'Falta credencial');
      return;
    }

    socket.send(armarMensaje('conexion.ok', { rol: socket.rol }));
    socket.on('error', (e) => log.aviso('WS error:', e.message));
  });

  log.info('WebSocket escuchando en /ws');
}

function repartir(filtro, evento, datos) {
  if (!wss) return;
  const mensaje = armarMensaje(evento, datos);
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN && filtro(socket)) socket.send(mensaje);
  }
}

/** A todos los clientes cuyo rol este en `roles`. */
const emitir = (evento, datos, roles = ['admin', 'usuario', 'gateway']) =>
  repartir((s) => roles.includes(s.rol), evento, datos);

/** Solo a la app de UNA persona (por legajo). */
const emitirA = (legajo, evento, datos) =>
  legajo && repartir((s) => s.rol === 'usuario' && s.legajo === legajo, evento, datos);

/** A las pantallas de locker abiertas frente a esa puerta. */
const emitirALocker = (lockerId, evento, datos) =>
  lockerId && repartir((s) => s.rol === 'operacion' && s.lockerId === lockerId, evento, datos);

module.exports = { iniciar, emitir, emitirA, emitirALocker };
