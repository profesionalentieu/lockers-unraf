'use strict';
/**
 * =====================================================================
 *  MAPA DE LA API v3 - Lockers UNRaf (spec tecnica de reservas por franja)
 * =====================================================================
 *
 *  PUBLICO
 *  GET    /api/salud                                                  -> { ok, version }
 *  POST   /api/auth/admin/login           { usuario, password }       -> { token }
 *  POST   /api/auth/usuario/login         { legajo, pin }             -> { token, usuario, reglas, vigente }
 *
 *  PUERTA (pantalla del QR, sin sesion: el codigo es la credencial)
 *  GET    /api/lockers                                                -> { lockers[] }  (datos publicos)
 *  GET    /api/lockers/:id                                            -> { locker }
 *  GET    /api/lockers/:id/qr.svg?base=                               -> imagen para imprimir
 *  POST   /api/lockers/:id/acceso         { codigo }                  -> 202 { operacion, token }
 *
 *  OPERACION EN CURSO (Bearer token de operacion)
 *  GET    /api/operacion                                              -> { operacion }
 *  POST   /api/operacion/reintentar                                   -> 202 { operacion }  "Reintentar Apertura"
 *  POST   /api/operacion/incidencia       { detalle }                 -> 201 { incidenciaId, presuntoResponsable }
 *
 *  ALUMNOS Y DOCENTES (Bearer JWT rol=usuario)
 *  GET    /api/usuario/perfil                                         -> { usuario, reglas, vigente }
 *  GET    /api/usuario/catalogo?fecha=&hora=&duracion=                -> { franja, items[], reglas }
 *  POST   /api/usuario/reservas           { lockerId, cantidad, fecha, horaInicio, duracionHoras }
 *                                                                     -> 201 { prestamo }
 *  GET    /api/usuario/reservas                                       -> { vigentes[], historial[] }
 *  GET    /api/usuario/reservas/:id                                   -> { prestamo }
 *  POST   /api/usuario/reservas/:id/cancelar                          -> { prestamo }
 *  POST   /api/usuario/reservas/:id/devolucion                        -> 202 { operacion, token }
 *  POST   /api/usuario/reservas/:id/incidencia  { detalle }           -> 201
 *
 *  MESA DE ALUMNADO (Bearer JWT rol=admin)
 *  GET    /api/admin/panel                                            -> { resumen, solicitudes, alertas, lockers }
 *  GET    /api/admin/lockers
 *  PUT    /api/admin/lockers/:id          { descripcionItem, categoria, capacidadMaxima, stockActualFisico }
 *  POST   /api/admin/lockers/:id/apertura-emergencia                  -> 202
 *  POST   /api/admin/lockers/:id/reponer-servicio
 *  GET    /api/admin/solicitudes
 *  POST   /api/admin/solicitudes/:id/aprobar                          -> PENDIENTE_APROBACION -> RESERVADO
 *  POST   /api/admin/solicitudes/:id/rechazar   { motivo? }           -> RECHAZADO
 *  GET    /api/admin/prestamos?estado=&fecha=&buscar=&limite=
 *  GET    /api/admin/prestamos/:id                                    -> { prestamo, trazabilidad[] }
 *  POST   /api/admin/prestamos/:id/cancelar
 *  POST   /api/admin/prestamos/:id/auditoria    { unidadesRecibidas?, sancionar? }  "Confirmar Stock OK"
 *  POST   /api/admin/prestamos/:id/devolucion-ventanilla
 *  POST   /api/admin/prestamos/:id/entrega-ventanilla                  (material de respaldo)
 *  POST   /api/admin/incidencias/:id/revisada
 *  POST   /api/admin/incidencias/:id/sancionar                         (al presunto responsable)
 *  GET    /api/admin/bitacora?limite=
 *  GET    /api/admin/usuarios?buscar=
 *  POST   /api/admin/usuarios             { legajo, nombre, pin, rol }
 *  POST   /api/admin/usuarios/importar    { texto }
 *  PATCH  /api/admin/usuarios/:legajo     { nombre, pin?, rol }
 *  DELETE /api/admin/usuarios/:legajo                                 -> baja logica
 *  POST   /api/admin/usuarios/:legajo/sancionar   { motivo }
 *  POST   /api/admin/usuarios/:legajo/rehabilitar
 *
 *  GATEWAY DE RADIO / PLACA WiFi (header x-api-key)
 *  GET    /api/gateway/comandos?limite=10                             -> { comandos[] }  (cada uno con ms: 15000)
 *  POST   /api/gateway/comandos/:id/ack   { ok, detalle }
 *  POST   /api/gateway/telemetria         { nodo, lecturas[], rssi }
 *  POST   /api/gateway/heartbeat          { nodo, rssi, bateriaMv }
 *
 *  TIEMPO REAL  (ws://host/ws?token=<jwt> | ?apiKey=<key>)
 *    admin     solicitud.nueva, prestamo.actualizado, locker.actualizado, alerta, usuario.actualizado
 *    usuario   prestamo.actualizado, locker.actualizado, alerta, usuario.actualizado, operacion.actualizada
 *    operacion operacion.actualizada, locker.actualizado, alerta
 *    gateway   comando.nuevo
 * =====================================================================
 */
const express = require('express');
const { requiereRol, requiereGateway } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const admin = require('../controllers/admin.controller');
const usuario = require('../controllers/usuario.controller');
const locker = require('../controllers/locker.controller');
const operacion = require('../controllers/operacion.controller');
const gateway = require('../controllers/gateway.controller');

const router = express.Router();

// ---------- Publico ----------
router.get('/salud', (req, res) => res.json({ ok: true, version: '3.0.0' }));
router.post('/auth/admin/login', auth.loginAdmin);
router.post('/auth/usuario/login', auth.loginUsuario);

// ---------- Puerta (QR) ----------
router.get('/lockers', locker.listar);
router.get('/lockers/:id', locker.ver);
router.get('/lockers/:id/qr.svg', locker.qr);
router.post('/lockers/:id/acceso', locker.acceso);

// ---------- Operacion en curso ----------
const soloOperacion = requiereRol('operacion');
router.get('/operacion', soloOperacion, operacion.estado);
router.post('/operacion/reintentar', soloOperacion, operacion.reintentar);
router.post('/operacion/incidencia', soloOperacion, operacion.reportar);

// ---------- Alumnos y docentes ----------
const soloUsuario = requiereRol('usuario');
router.get('/usuario/perfil', soloUsuario, usuario.perfil);
router.get('/usuario/catalogo', soloUsuario, usuario.catalogo);
router.get('/usuario/reservas', soloUsuario, usuario.misReservas);
router.post('/usuario/reservas', soloUsuario, usuario.reservar);
router.get('/usuario/reservas/:id', soloUsuario, usuario.verReserva);
router.post('/usuario/reservas/:id/cancelar', soloUsuario, usuario.cancelar);
router.post('/usuario/reservas/:id/devolucion', soloUsuario, usuario.iniciarDevolucion);
router.post('/usuario/reservas/:id/incidencia', soloUsuario, usuario.reportar);

// ---------- Mesa de Alumnado ----------
const soloAdmin = requiereRol('admin');
router.get('/admin/panel', soloAdmin, admin.panel);
router.get('/admin/lockers', soloAdmin, admin.listarLockers);
router.put('/admin/lockers/:id', soloAdmin, admin.configurarLocker);
router.post('/admin/lockers/:id/apertura-emergencia', soloAdmin, admin.aperturaEmergencia);
router.post('/admin/lockers/:id/reponer-servicio', soloAdmin, admin.reponerServicio);
router.get('/admin/solicitudes', soloAdmin, admin.listarSolicitudes);
router.post('/admin/solicitudes/:id/aprobar', soloAdmin, admin.aprobar);
router.post('/admin/solicitudes/:id/rechazar', soloAdmin, admin.rechazar);
router.get('/admin/prestamos', soloAdmin, admin.listarPrestamos);
router.get('/admin/prestamos/:id', soloAdmin, admin.verPrestamo);
router.post('/admin/prestamos/:id/cancelar', soloAdmin, admin.cancelar);
router.post('/admin/prestamos/:id/auditoria', soloAdmin, admin.confirmarAuditoria);
router.post('/admin/prestamos/:id/devolucion-ventanilla', soloAdmin, admin.devolucionVentanilla);
router.post('/admin/prestamos/:id/entrega-ventanilla', soloAdmin, admin.entregaVentanilla);
router.post('/admin/incidencias/:id/revisada', soloAdmin, admin.incidenciaRevisada);
router.post('/admin/incidencias/:id/sancionar', soloAdmin, admin.sancionarResponsable);
router.get('/admin/bitacora', soloAdmin, admin.bitacora);
router.get('/admin/usuarios', soloAdmin, admin.listarUsuarios);
router.post('/admin/usuarios', soloAdmin, admin.crearUsuario);
router.post('/admin/usuarios/importar', soloAdmin, admin.importarUsuarios);
router.patch('/admin/usuarios/:legajo', soloAdmin, admin.editarUsuario);
router.delete('/admin/usuarios/:legajo', soloAdmin, admin.bajaUsuario);
router.post('/admin/usuarios/:legajo/sancionar', soloAdmin, admin.sancionar);
router.post('/admin/usuarios/:legajo/rehabilitar', soloAdmin, admin.rehabilitar);

// ---------- Gateway de radio ----------
router.get('/gateway/comandos', requiereGateway, gateway.obtenerComandos);
router.post('/gateway/comandos/:id/ack', requiereGateway, gateway.confirmarComando);
router.post('/gateway/telemetria', requiereGateway, gateway.recibirTelemetria);
router.post('/gateway/heartbeat', requiereGateway, gateway.heartbeat);

module.exports = router;
