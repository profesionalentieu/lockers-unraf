'use strict';
/** Endpoints de la Mesa de Alumnado: aprobaciones, alertas, auditoria, stock y padron. */
const env = require('../config/env');
const { ErrorNegocio } = require('../utils/errores');
const lockers = require('../services/locker.service');
const prestamos = require('../services/prestamo.service');
const operaciones = require('../services/operacion.service');
const usuarios = require('../services/usuario.service');
const auditoria = require('../services/auditoria.service');
const eventos = require('../services/evento.service');

const actor = (req) => req.usuario.usuario;
const id = (req) => Number(req.params.id);

/** Envuelve un handler sincrono: errores al manejador central. */
const manejar = (fn, codigo = 200) => (req, res, next) => {
  try { res.status(codigo).json(fn(req)); } catch (e) { next(e); }
};

/* ---------- Tablero ---------- */

/**
 * GET /api/admin/panel
 * Todo lo que Alumnado tiene que ver o resolver, en una sola llamada. Las
 * alertas se reconstruyen desde la base: un panel que entra tarde ve lo
 * mismo que uno que estaba abierto.
 */
const panel = manejar(() => {
  const lista = lockers.listar();
  return {
    resumen: prestamos.resumen(),
    solicitudes: prestamos.pendientesDeAprobacion(),
    alertas: {
      mora: prestamos.enMora(),
      auditoria: prestamos.pendientesAuditoria(),
      incidencias: auditoria.incidenciasPendientes(),
      respaldo: prestamos.requierenRespaldo(),
      puertas: lista.filter(
        (l) => l.alertaPuertaAbierta || l.estado === 'ERROR' || l.segundosAbierta >= env.reglas.alertaPuertaAbiertaSeg
      ),
    },
    lockers: lista,
  };
});

/* ---------- Lockers ---------- */

const listarLockers = manejar(() => ({ lockers: lockers.listar() }));

/** PUT /api/admin/lockers/:id  { descripcionItem, categoria, capacidadMaxima, stockActualFisico } */
const configurarLocker = manejar((req) => {
  const locker = lockers.configurar(String(req.params.id).toUpperCase(), req.body || {});
  eventos.registrar(eventos.TIPOS.INVENTARIO_ACTUALIZADO, {
    lockerId: locker.id, actor: actor(req),
    detalle: `${locker.descripcionItem}: stock ${locker.stockActualFisico} / capacidad ${locker.capacidadMaxima}`,
  });
  lockers.notificar(locker.id);
  return { locker };
});

/** POST /api/admin/lockers/:id/apertura-emergencia */
const aperturaEmergencia = manejar((req) => operaciones.aperturaEmergencia(req.params.id, { actor: actor(req) }), 202);

/** POST /api/admin/lockers/:id/reponer-servicio -> saca del estado ERROR */
const reponerServicio = manejar((req) => {
  const lockerId = String(req.params.id).toUpperCase();
  if (!lockers.fila(lockerId)) throw new ErrorNegocio('El locker no existe', 404);
  lockers.marcarOperativo(lockerId, true);
  lockers.notificar(lockerId);
  return { locker: lockers.obtener(lockerId) };
});

/* ---------- Solicitudes ---------- */

const listarSolicitudes = manejar(() => ({ solicitudes: prestamos.pendientesDeAprobacion(), resumen: prestamos.resumen() }));
const aprobar = manejar((req) => prestamos.aprobar(id(req), { actor: actor(req) }));
const rechazar = manejar((req) => prestamos.rechazar(id(req), { actor: actor(req), motivo: req.body?.motivo || null }));

/* ---------- Prestamos ---------- */

/** GET /api/admin/prestamos?estado=&fecha=&buscar=&limite= */
const listarPrestamos = manejar((req) => ({
  prestamos: prestamos.historial({
    estado: req.query.estado || 'todos',
    fecha: req.query.fecha || '',
    buscar: req.query.buscar || '',
    limite: req.query.limite,
  }),
  resumen: prestamos.resumen(),
}));

/** GET /api/admin/prestamos/:id -> detalle con su trazabilidad fisica */
const verPrestamo = manejar((req) => {
  const prestamo = prestamos.obtener(id(req), { conCodigo: true });
  if (!prestamo) throw new ErrorNegocio('El préstamo no existe', 404);
  return { prestamo, trazabilidad: auditoria.dePrestamo(prestamo.id) };
});

const cancelar = manejar((req) => prestamos.cancelar(id(req), { actor: actor(req), motivo: req.body?.motivo || 'Cancelada por Alumnado' }));

/** POST /api/admin/prestamos/:id/auditoria  { unidadesRecibidas?, sancionar? } -> "Confirmar Stock OK" */
const confirmarAuditoria = manejar((req) =>
  prestamos.confirmarAuditoria(id(req), {
    actor: actor(req),
    unidadesRecibidas: req.body?.unidadesRecibidas ?? null,
    sancionar: Boolean(req.body?.sancionar),
  })
);

const devolucionVentanilla = manejar((req) => prestamos.devolucionVentanilla(id(req), { actor: actor(req) }));
const entregaVentanilla = manejar((req) => prestamos.entregaVentanilla(id(req), { actor: actor(req) }));

/* ---------- Incidencias (reportes de faltante) ---------- */

/** POST /api/admin/incidencias/:id/revisada */
const incidenciaRevisada = manejar((req) => {
  if (!auditoria.marcarRevisada(id(req))) throw new ErrorNegocio('El reporte no existe', 404);
  return { ok: true };
});

/** POST /api/admin/incidencias/:id/sancionar -> sanciona al presunto responsable */
const sancionarResponsable = manejar((req) => {
  const incidencia = auditoria.obtenerIncidencia(id(req));
  if (!incidencia) throw new ErrorNegocio('El reporte no existe', 404);
  const legajo = incidencia.ultimo_responsable_previo;
  if (!legajo || legajo === auditoria.SIN_RESPONSABLE)
    throw new ErrorNegocio('El reporte no tiene un responsable identificado', 409);
  const usuario = usuarios.sancionar(legajo, `Faltante reportado en ${incidencia.locker_id} (reporte #${incidencia.id})`, {
    actor: actor(req), lockerId: incidencia.locker_id, prestamoId: incidencia.prestamo_id,
  });
  auditoria.marcarRevisada(incidencia.id);
  return { usuario };
});

/* ---------- Bitacora ---------- */

const bitacora = manejar((req) => ({ eventos: eventos.feed(Math.min(Number(req.query.limite) || 40, 200)) }));

/* ---------- Padron ---------- */

const listarUsuarios = manejar((req) => ({ usuarios: usuarios.listar(req.query.buscar || '') }));
const crearUsuario = manejar((req) => ({ usuario: usuarios.crear(req.body || {}) }), 201);
const importarUsuarios = manejar((req) => usuarios.importar(req.body?.texto));
const editarUsuario = manejar((req) => ({ usuario: usuarios.actualizar(req.params.legajo, req.body || {}) }));
const bajaUsuario = manejar((req) => usuarios.desactivar(req.params.legajo));
const sancionar = manejar((req) => {
  const motivo = String(req.body?.motivo || '').trim();
  if (motivo.length < 3) throw new ErrorNegocio('Escribí el motivo de la sanción', 400);
  return { usuario: usuarios.sancionar(req.params.legajo, motivo, { actor: actor(req) }) };
});
const rehabilitar = manejar((req) => ({ usuario: usuarios.rehabilitar(req.params.legajo, { actor: actor(req) }) }));

module.exports = {
  panel, listarLockers, configurarLocker, aperturaEmergencia, reponerServicio,
  listarSolicitudes, aprobar, rechazar,
  listarPrestamos, verPrestamo, cancelar, confirmarAuditoria, devolucionVentanilla, entregaVentanilla,
  incidenciaRevisada, sancionarResponsable, bitacora,
  listarUsuarios, crearUsuario, importarUsuarios, editarUsuario, bajaUsuario, sancionar, rehabilitar,
};
