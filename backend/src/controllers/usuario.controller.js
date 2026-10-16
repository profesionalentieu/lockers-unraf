'use strict';
/** Endpoints de la app de alumnos y docentes. */
const env = require('../config/env');
const reloj = require('../utils/reloj');
const { firmarToken } = require('../middleware/auth');
const { ErrorNegocio } = require('../utils/errores');
const lockers = require('../services/locker.service');
const prestamos = require('../services/prestamo.service');
const operaciones = require('../services/operacion.service');
const usuarios = require('../services/usuario.service');

const R = env.reglas;

/** GET /api/usuario/perfil -> quien soy, mis reglas, mi sancion y mi reserva vigente */
function perfil(req, res) {
  const usuario = usuarios.buscar(req.usuario.legajo);
  if (!usuario) return res.status(401).json({ error: 'Tu usuario ya no está habilitado' });
  res.json({ usuario, reglas: prestamos.reglasPara(usuario.rol), vigente: prestamos.vigenteDe(usuario.legajo) });
}

/** Proximo inicio de franja posible (redondeado al paso, dentro del horario). */
function proximaHora() {
  const ahora = reloj.minutosDelDia();
  const redondeado = Math.floor(ahora / R.pasoFranjaMin) * R.pasoFranjaMin;
  return reloj.aHora(Math.min(Math.max(redondeado, R.horarioAperturaMin), R.horarioCierreMin - 60));
}

/**
 * GET /api/usuario/catalogo?fecha=&hora=&duracion=
 * Que hay en cada locker y cuanto se puede reservar EN ESA FRANJA.
 * Si la franja no es valida para el rol, igual devuelve el catalogo con el
 * motivo, asi la interfaz lo explica en vez de mostrar un error seco.
 */
function catalogo(req, res) {
  const rol = req.usuario.rolUsuario;
  const fecha = req.query.fecha || reloj.fechaLocal();
  const horaInicio = req.query.hora || proximaHora();
  const duracionHoras = Number(req.query.duracion) || 1;

  let franja = null;
  let error = null;
  try {
    franja = prestamos.validarFranja(rol, { fecha, horaInicio, duracionHoras });
  } catch (e) {
    error = e.message;
  }

  const items = lockers.listar().map((l) => {
    const disponible = franja ? lockers.disponibleEnFranja(l.id, franja.inicioMs, franja.finBufferMs) : null;
    const maximo = disponible == null ? 0 : rol === 'alumno' ? Math.min(1, disponible) : disponible;
    return {
      lockerId: l.id,
      descripcionItem: l.descripcionItem,
      categoria: l.categoria,
      ubicacion: l.nodo.ubicacion,
      capacidadMaxima: l.capacidadMaxima,
      stock: l.stockActualFisico,
      disponible,
      maximo,
      // Docente: por encima de esto la reserva pasa por Alumnado
      umbralAprobacion: Math.floor(l.capacidadMaxima / 2),
      fueraDeServicio: l.estado === 'ERROR',
      sePuedePedir: Boolean(franja) && maximo > 0 && l.estado !== 'ERROR',
    };
  });

  res.json({
    franja: {
      fecha, horaInicio, duracionHoras,
      horaLimite: franja?.horaLimite ?? null,
      horaFinBuffer: franja?.horaFinBuffer ?? null,
      valida: Boolean(franja),
      error,
    },
    items,
    reglas: prestamos.reglasPara(rol),
  });
}

/** POST /api/usuario/reservas  { lockerId, cantidad, fecha, horaInicio, duracionHoras } */
function reservar(req, res, next) {
  try {
    const { lockerId, cantidad, fecha, horaInicio, duracionHoras } = req.body || {};
    const resultado = prestamos.solicitar({
      legajo: req.usuario.legajo, lockerId, cantidad, fecha, horaInicio, duracionHoras,
    });
    res.status(201).json(resultado);
  } catch (e) { next(e); }
}

/** GET /api/usuario/reservas -> { vigentes[], historial[] } */
const misReservas = (req, res) => res.json(prestamos.porUsuario(req.usuario.legajo));

/** Trae un prestamo verificando que sea de quien pregunta. */
function propio(req) {
  const prestamo = prestamos.obtener(Number(req.params.id), { conCodigo: true });
  if (!prestamo) throw new ErrorNegocio('La reserva no existe', 404);
  if (prestamo.usuario.legajo !== req.usuario.legajo) throw new ErrorNegocio('Esa reserva no es tuya', 403);
  return prestamo;
}

/** GET /api/usuario/reservas/:id -> respaldo del WebSocket */
function verReserva(req, res, next) {
  try { res.json({ prestamo: propio(req) }); } catch (e) { next(e); }
}

/** POST /api/usuario/reservas/:id/cancelar */
function cancelar(req, res, next) {
  try {
    propio(req);
    res.json(prestamos.cancelar(Number(req.params.id), { legajo: req.usuario.legajo, actor: req.usuario.legajo }));
  } catch (e) { next(e); }
}

/**
 * POST /api/usuario/reservas/:id/devolucion
 * "Iniciar Devolucion" desde la sesion (spec 3.1.2): arranca el pulso y
 * devuelve el token de operacion para seguirlo en la pantalla del locker.
 */
function iniciarDevolucion(req, res, next) {
  try {
    const operacion = operaciones.devolucionDesdeSesion(Number(req.params.id), req.usuario.legajo);
    res.status(202).json({ operacion, token: tokenOperacion(operacion, req.usuario.legajo) });
  } catch (e) { next(e); }
}

/** POST /api/usuario/reservas/:id/incidencia  { detalle } */
function reportar(req, res, next) {
  try {
    res.status(201).json(
      operaciones.reportarIncidencia(Number(req.params.id), { legajo: req.usuario.legajo, detalle: req.body?.detalle })
    );
  } catch (e) { next(e); }
}

/** Token corto para la pantalla del locker. */
const tokenOperacion = (operacion, legajo) =>
  firmarToken(
    { rol: 'operacion', lockerId: operacion.locker.id, prestamoId: operacion.prestamo.id, tipo: operacion.tipo, legajo },
    env.jwt.expiraOperacion
  );

module.exports = { perfil, catalogo, reservar, misReservas, verReserva, cancelar, iniciarDevolucion, reportar, tokenOperacion };
