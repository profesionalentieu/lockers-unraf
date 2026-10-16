'use strict';
/**
 * Prestamos: el ciclo de vida completo de una reserva (spec, seccion 3).
 *
 *                    ┌─ Alumno o >50% ─> PENDIENTE_APROBACION ─(rechazo)─> RECHAZADO
 *   Nueva solicitud ─┤                          │ (aprobado)
 *                    └─ Docente <=50% ───> RESERVADO  (codigo de 6 digitos)
 *                                           │                      │
 *                       15 min sin abrir ───┤                      ├── QR + codigo
 *                                           ▼                      ▼
 *                                   CANCELADO_NO_SHOW            EN_USO ──(limite)──> EN_MORA
 *                                                                  │                     │
 *                                         Docente <=50% en termino │ Alumno, >50% o mora │
 *                                                ▼                 ▼                     ▼
 *                                         BUFFER_30_MIN       PENDIENTE_AUDITORIA <──────┘
 *                                                │ (30 min)        │ (OK de Alumnado)
 *                                                ▼                 ▼
 *                                            FINALIZADO        FINALIZADO
 *
 * Este modulo maneja las transiciones de NEGOCIO. Las que dispara el
 * hardware (RESERVADO -> EN_USO al cerrar la puerta, devolucion al cerrar)
 * las inicia operacion.service.js y terminan llamando a las funciones de
 * aca (marcarRetirado, registrarDevolucion).
 */
const crypto = require('crypto');
const { db } = require('../config/database');
const env = require('../config/env');
const reloj = require('../utils/reloj');
const hub = require('../realtime/hub');
const { ErrorNegocio } = require('../utils/errores');
const lockers = require('./locker.service');
const usuarios = require('./usuario.service');
const eventos = require('./evento.service');
const { alertar, NIVELES } = require('./alerta.service');

const R = env.reglas;
const MIN = 60000;

/** Estados que cuentan como "la reserva vigente" de una persona. */
const ESTADOS_VIGENTES = usuarios.ESTADOS_VIGENTES;
/** Estados en los que la persona ve su codigo de operacion. */
const ESTADOS_CON_CODIGO = ['RESERVADO', 'EN_USO', 'EN_MORA'];

/* ============================================================
   Reglas por rol (spec, seccion 1)
   ============================================================ */

function reglasPara(rol) {
  const comunes = {
    duraciones: R.duracionesHoras,
    horarioApertura: reloj.aHora(R.horarioAperturaMin),
    horarioCierre: reloj.aHora(R.horarioCierreMin),
    pasoFranjaMin: R.pasoFranjaMin,
    toleranciaRetiroMin: R.toleranciaRetiroMin,
    bufferMin: R.bufferPosdevolucionMin,
    pulsoAperturaSeg: R.pulsoAperturaSeg,
    hoy: reloj.fechaLocal(),
    ahora: reloj.horaLocal(),
  };
  if (rol === 'docente') {
    return {
      ...comunes,
      rol,
      cantidadMaxima: null,               // hasta el 100% de lo disponible en la franja
      diasAnticipacion: R.docenteDiasAnticipacion,
      aprobacion: 'si_supera_50',
      descripcion: `Hasta el 100% del stock · hasta ${R.docenteDiasAnticipacion} días de anticipación · 1 reserva activa · aprobación solo si pedís más del 50% de la capacidad`,
    };
  }
  return {
    ...comunes,
    rol: 'alumno',
    cantidadMaxima: 1,
    diasAnticipacion: 0,
    aprobacion: 'siempre',
    descripcion: '1 unidad · solo para hoy · 1 préstamo activo · siempre con aprobación de Alumnado',
  };
}

/* ============================================================
   Lectura
   ============================================================ */

const SQL_PRESTAMOS = `
  SELECT p.*, u.nombre AS usuario_nombre, u.rol, u.sancionado,
         l.descripcion_item AS locker_item, l.capacidad_maxima
  FROM prestamos p
  JOIN usuarios u ON u.legajo = p.legajo_usuario
  JOIN lockers l  ON l.id = p.locker_id
`;

/**
 * Objeto que ven los frontends.
 * @param {boolean} conCodigo  el codigo solo viaja a su dueño (y a Alumnado)
 */
function mapear(f, { conCodigo = false } = {}) {
  const t = reloj.ahoraMs();
  const limite = Date.parse(f.limite_ts);
  const mostrarCodigo = conCodigo && ESTADOS_CON_CODIGO.includes(f.estado);
  return {
    id: f.id,
    estado: f.estado,
    cantidad: f.cantidad,
    codigoOperacion: mostrarCodigo ? f.codigo_operacion : null,
    fechaReserva: f.fecha_reserva,
    horaInicio: f.hora_inicio,
    duracionHoras: f.duracion_horas,
    horaLimite: f.hora_limite,
    horaFinBuffer: f.hora_fin_buffer,
    inicio: f.inicio_ts,
    limite: f.limite_ts,
    finBuffer: f.fin_buffer_ts,
    retiroHasta: reloj.iso(Date.parse(f.inicio_ts) + R.toleranciaRetiroMin * MIN),
    timestampRetiro: f.timestamp_retiro,
    timestampDevolucion: f.timestamp_devolucion,
    creadoEn: f.creado_en,
    requiereAprobacion: Boolean(f.requiere_aprobacion),
    resueltoPor: f.resuelto_por,
    resueltoEn: f.resuelto_en,
    motivoRechazo: f.motivo_rechazo,
    intentosApertura: f.intentos_apertura,
    devolucionEnTermino: f.devolucion_en_termino == null ? null : Boolean(f.devolucion_en_termino),
    caminoDevolucion: f.camino_devolucion,
    moraDesde: f.mora_desde,
    minutosDemora: f.estado === 'EN_MORA' ? Math.max(0, Math.floor((t - limite) / MIN)) : null,
    minutosEsperando: f.estado === 'PENDIENTE_APROBACION' ? Math.floor((t - Date.parse(f.creado_en)) / MIN) : null,
    auditadoPor: f.auditado_por,
    auditadoEn: f.auditado_en,
    unidadesRecibidas: f.unidades_recibidas,
    lockerOriginalId: f.locker_original_id,
    requiereRespaldo: Boolean(f.requiere_respaldo),
    entregadoEnVentanilla: Boolean(f.entregado_en_ventanilla),
    descripcionItem: f.descripcion_item,
    porcentajeCapacidad: f.capacidad_maxima ? Math.round((f.cantidad / f.capacidad_maxima) * 100) : null,
    locker: { id: f.locker_id, descripcionItem: f.locker_item, capacidadMaxima: f.capacidad_maxima },
    usuario: { legajo: f.legajo_usuario, nombre: f.usuario_nombre, rol: f.rol, sancionado: Boolean(f.sancionado) },
  };
}

const fila = (id) => db.prepare(`${SQL_PRESTAMOS} WHERE p.id = ?`).get(Number(id));
const obtener = (id, opciones = {}) => {
  const f = fila(id);
  return f ? mapear(f, opciones) : null;
};

const listarPorEstado = (estado, orden = 'p.inicio_ts ASC') =>
  db.prepare(`${SQL_PRESTAMOS} WHERE p.estado = ? ORDER BY ${orden}`).all(estado).map((f) => mapear(f, { conCodigo: true }));

const pendientesDeAprobacion = () => listarPorEstado('PENDIENTE_APROBACION', 'p.creado_en ASC');
const enMora = () => listarPorEstado('EN_MORA', 'p.limite_ts ASC');
const pendientesAuditoria = () => listarPorEstado('PENDIENTE_AUDITORIA', 'p.timestamp_devolucion ASC');
const requierenRespaldo = () =>
  db.prepare(`${SQL_PRESTAMOS} WHERE p.requiere_respaldo = 1 AND p.estado = 'RESERVADO' ORDER BY p.inicio_ts`)
    .all().map((f) => mapear(f, { conCodigo: true }));

/** La reserva vigente de una persona, si tiene. */
function vigenteDe(legajo) {
  const f = db
    .prepare(`${SQL_PRESTAMOS} WHERE p.legajo_usuario = ? AND p.estado IN
              (${ESTADOS_VIGENTES.map(() => '?').join(',')}) ORDER BY p.inicio_ts LIMIT 1`)
    .get(legajo, ...ESTADOS_VIGENTES);
  return f ? mapear(f, { conCodigo: true }) : null;
}

/** Lo de una persona, separado entre lo que sigue abierto y el historial. */
function porUsuario(legajo) {
  const lista = db
    .prepare(`${SQL_PRESTAMOS} WHERE p.legajo_usuario = ? ORDER BY p.inicio_ts DESC LIMIT 60`)
    .all(legajo)
    .map((f) => mapear(f, { conCodigo: true }));
  const abiertos = [...ESTADOS_VIGENTES, 'PENDIENTE_AUDITORIA', 'BUFFER_30_MIN'];
  return {
    vigentes: lista.filter((p) => abiertos.includes(p.estado)).reverse(),
    historial: lista.filter((p) => !abiertos.includes(p.estado)),
  };
}

/** Trazabilidad para Alumnado, con filtros. */
function historial({ estado = 'todos', buscar = '', fecha = '', limite = 150 } = {}) {
  const condiciones = [];
  const parametros = [];
  if (estado && estado !== 'todos') { condiciones.push('p.estado = ?'); parametros.push(estado); }
  if (fecha) { condiciones.push('p.fecha_reserva = ?'); parametros.push(fecha); }
  if (String(buscar).trim()) {
    condiciones.push('(p.legajo_usuario LIKE ? OR u.nombre LIKE ? OR p.descripcion_item LIKE ? OR p.locker_id LIKE ?)');
    const patron = `%${String(buscar).trim()}%`;
    parametros.push(patron, patron, patron, patron);
  }
  const where = condiciones.length ? ` WHERE ${condiciones.join(' AND ')}` : '';
  return db
    .prepare(`${SQL_PRESTAMOS}${where} ORDER BY p.inicio_ts DESC, p.id DESC LIMIT ?`)
    .all(...parametros, Math.min(Number(limite) || 150, 500))
    .map((f) => mapear(f, { conCodigo: true }));
}

/** Contadores del encabezado del panel. */
function resumen() {
  const hoy = reloj.fechaLocal();
  const f = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE estado = 'PENDIENTE_APROBACION') AS por_aprobar,
         COUNT(*) FILTER (WHERE estado = 'RESERVADO' AND fecha_reserva = ?) AS reservas_hoy,
         COUNT(*) FILTER (WHERE estado = 'EN_USO')                AS en_uso,
         COUNT(*) FILTER (WHERE estado = 'EN_MORA')               AS en_mora,
         COUNT(*) FILTER (WHERE estado = 'PENDIENTE_AUDITORIA')   AS por_auditar,
         COALESCE(SUM(CASE WHEN estado IN ('EN_USO','EN_MORA') THEN cantidad END), 0) AS unidades_afuera
       FROM prestamos`
    )
    .get(hoy);
  return {
    porAprobar: f.por_aprobar,
    reservasHoy: f.reservas_hoy,
    enUso: f.en_uso,
    enMora: f.en_mora,
    porAuditar: f.por_auditar,
    unidadesAfuera: f.unidades_afuera,
  };
}

/* ============================================================
   Avisos
   ============================================================ */

/** Empuja el prestamo a su dueño (con codigo) y al panel. */
function emitir(id) {
  const f = fila(id);
  if (!f) return null;
  hub.emitirA(f.legajo_usuario, 'prestamo.actualizado', mapear(f, { conCodigo: true }));
  hub.emitir('prestamo.actualizado', mapear(f, { conCodigo: true }), ['admin']);
  return mapear(f, { conCodigo: true });
}

/* ============================================================
   Franjas
   ============================================================ */

/** Calcula la franja completa a partir de lo que elige la persona. */
function calcularFranja(fecha, horaInicio, duracionHoras) {
  const inicioMs = reloj.instante(fecha, horaInicio);
  const limiteMs = inicioMs + duracionHoras * 60 * MIN;
  const finBufferMs = limiteMs + R.bufferPosdevolucionMin * MIN;
  return {
    inicioMs, limiteMs, finBufferMs,
    horaLimite: reloj.horaLocal(limiteMs),
    horaFinBuffer: reloj.horaLocal(finBufferMs),
  };
}

/**
 * Valida fecha, hora y duracion segun el rol. Devuelve la franja calculada.
 * Todo lo que se valida aca tambien lo filtra la interfaz, pero la regla
 * real es esta: cualquiera puede mandar el POST a mano.
 */
function validarFranja(rol, { fecha, horaInicio, duracionHoras }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')))
    throw new ErrorNegocio('Elegí una fecha válida', 400);
  if (!/^\d{2}:\d{2}$/.test(String(horaInicio || '')))
    throw new ErrorNegocio('Elegí una hora de inicio válida', 400);
  const duracion = Number(duracionHoras);
  if (!R.duracionesHoras.includes(duracion))
    throw new ErrorNegocio('La duración tiene que ser de 1, 2, 3 o 4 horas', 400);

  const hoy = reloj.fechaLocal();
  const dias = reloj.diasEntre(hoy, fecha);
  if (rol === 'alumno' && dias !== 0)
    throw new ErrorNegocio('Los alumnos solo pueden reservar para el día en curso', 400);
  if (rol === 'docente' && (dias < 0 || dias > R.docenteDiasAnticipacion))
    throw new ErrorNegocio(`Podés reservar desde hoy hasta ${R.docenteDiasAnticipacion} días adelante`, 400);

  const inicioMin = reloj.aMinutos(horaInicio);
  if (inicioMin % R.pasoFranjaMin !== 0)
    throw new ErrorNegocio(`La hora de inicio va en pasos de ${R.pasoFranjaMin} minutos`, 400);
  if (inicioMin < R.horarioAperturaMin || inicioMin + duracion * 60 > R.horarioCierreMin)
    throw new ErrorNegocio(
      `El pañol atiende de ${reloj.aHora(R.horarioAperturaMin)} a ${reloj.aHora(R.horarioCierreMin)}: la franja tiene que terminar antes del cierre`,
      400
    );

  const franja = calcularFranja(fecha, horaInicio, duracion);
  // Se acepta una franja que ya empezo mientras siga abierta la tolerancia de retiro.
  if (franja.inicioMs + R.toleranciaRetiroMin * MIN <= reloj.ahoraMs())
    throw new ErrorNegocio('Esa franja ya pasó', 400);

  return { ...franja, duracion };
}

/** Codigo unico de 6 digitos. */
function generarCodigo() {
  const existe = db.prepare(`SELECT 1 FROM prestamos WHERE codigo_operacion = ?`);
  for (let i = 0; i < 50; i++) {
    const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    if (!existe.get(codigo)) return codigo;
  }
  throw new ErrorNegocio('No se pudo generar un código, probá de nuevo', 503);
}

/* ============================================================
   1. SOLICITUD
   ============================================================ */

/**
 * Crea la reserva (o la solicitud, si necesita aprobacion).
 *
 * La validacion de stock y el INSERT van en la MISMA transaccion: si dos
 * personas piden las ultimas unidades de una franja con medio segundo de
 * diferencia, la segunda encuentra el stock ya bloqueado y recibe el error.
 */
function solicitar({ legajo, lockerId, cantidad, fecha, horaInicio, duracionHoras }) {
  const usuario = usuarios.buscar(legajo);
  if (!usuario || usuario.rol === 'admin') throw new ErrorNegocio('Usuario no encontrado', 404);
  if (usuario.sancionado)
    throw new ErrorNegocio(
      `Tu legajo está sancionado${usuario.motivoSancion ? ` (${usuario.motivoSancion})` : ''}. Acercate a Alumnado para rehabilitarlo.`,
      403
    );

  const pedido = cantidad == null && usuario.rol === 'alumno' ? 1 : Number(cantidad);
  if (!Number.isInteger(pedido) || pedido <= 0)
    throw new ErrorNegocio('La cantidad tiene que ser un número entero mayor a cero', 400);
  if (usuario.rol === 'alumno' && pedido !== 1)
    throw new ErrorNegocio('Los alumnos pueden pedir 1 unidad por reserva', 400);

  const franja = validarFranja(usuario.rol, { fecha, horaInicio, duracionHoras });

  const transaccion = db.transaction(() => {
    const vigente = vigenteDe(usuario.legajo);
    if (vigente)
      throw new ErrorNegocio(
        usuario.rol === 'docente'
          ? 'Ya tenés una reserva activa. Se habilita una nueva cuando la concretes o la canceles.'
          : 'Ya tenés un préstamo activo. Devolvelo o cancelalo antes de pedir otro.',
        409
      );

    const locker = lockers.fila(String(lockerId || '').toUpperCase());
    if (!locker) throw new ErrorNegocio('El locker no existe', 404);
    if (locker.estado_operativo === 'error')
      throw new ErrorNegocio(`${locker.id} está fuera de servicio`, 409);

    const disponible = lockers.disponibleEnFranja(locker.id, franja.inicioMs, franja.finBufferMs);
    if (pedido > disponible)
      throw new ErrorNegocio(
        disponible
          ? `En esa franja quedan ${disponible} unidad(es) de ${locker.descripcion_item} en ${locker.id}`
          : `No quedan unidades de ${locker.descripcion_item} en ${locker.id} para esa franja`,
        409
      );

    // Alumno: siempre. Docente: solo si supera el 50% de la capacidad maxima.
    const requiere = usuario.rol === 'alumno' || pedido > locker.capacidad_maxima / 2;
    const estado = requiere ? 'PENDIENTE_APROBACION' : 'RESERVADO';

    const info = db
      .prepare(
        `INSERT INTO prestamos
           (legajo_usuario, locker_id, cantidad, codigo_operacion, fecha_reserva, hora_inicio,
            duracion_horas, hora_limite, hora_fin_buffer, estado,
            inicio_ts, limite_ts, fin_buffer_ts, descripcion_item, creado_en, requiere_aprobacion,
            resuelto_por, resuelto_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usuario.legajo, locker.id, pedido, generarCodigo(), fecha, horaInicio,
        franja.duracion, franja.horaLimite, franja.horaFinBuffer, estado,
        reloj.iso(franja.inicioMs), reloj.iso(franja.limiteMs), reloj.iso(franja.finBufferMs),
        locker.descripcion_item, reloj.ahora(), requiere ? 1 : 0,
        requiere ? null : 'automatico', requiere ? null : reloj.ahora()
      );
    return { id: Number(info.lastInsertRowid), locker, requiere };
  });

  const { id, locker, requiere } = transaccion();

  eventos.registrar(requiere ? eventos.TIPOS.SOLICITUD : eventos.TIPOS.RESERVA_AUTOMATICA, {
    lockerId: locker.id,
    prestamoId: id,
    actor: usuario.legajo,
    detalle: `${pedido} x ${locker.descripcion_item} · ${fecha} ${horaInicio} (${franja.duracion} h)`,
  });

  const prestamo = emitir(id);
  if (requiere) hub.emitir('solicitud.nueva', prestamo, ['admin']);
  lockers.notificar(locker.id);
  return { prestamo };
}

/* ============================================================
   2. APROBACION / RECHAZO / CANCELACION
   ============================================================ */

function exigirEstado(prestamo, permitidos, mensaje) {
  if (!prestamo) throw new ErrorNegocio('La reserva no existe', 404);
  if (!permitidos.includes(prestamo.estado))
    throw new ErrorNegocio(mensaje || `La reserva está en estado ${prestamo.estado}`, 409);
}

/** Alumnado aprueba: pasa a RESERVADO y la persona recibe su codigo. */
function aprobar(id, { actor }) {
  const transaccion = db.transaction(() => {
    const p = fila(id);
    exigirEstado(p, ['PENDIENTE_APROBACION'], p && `Esa solicitud ya estaba ${p.estado}`);
    if (Date.parse(p.inicio_ts) + R.toleranciaRetiroMin * MIN <= reloj.ahoraMs())
      throw new ErrorNegocio('La franja de esa solicitud ya venció', 409);

    // La solicitud ya bloqueaba sus unidades; igual se revalida por si
    // algo cambio mientras esperaba (una mora, un faltante descontado).
    const disponible = lockers.disponibleEnFranja(
      p.locker_id, Date.parse(p.inicio_ts), Date.parse(p.fin_buffer_ts), { excluirId: p.id }
    );
    if (p.cantidad > disponible)
      throw new ErrorNegocio(`Ya no alcanza el stock: quedan ${disponible} en esa franja`, 409);

    db.prepare(`UPDATE prestamos SET estado = 'RESERVADO', resuelto_por = ?, resuelto_en = ? WHERE id = ?`)
      .run(actor, reloj.ahora(), id);
    return p;
  });
  const p = transaccion();

  eventos.registrar(eventos.TIPOS.SOLICITUD_APROBADA, {
    lockerId: p.locker_id, prestamoId: p.id, actor,
    detalle: `${p.cantidad} x ${p.descripcion_item} para ${p.legajo_usuario}`,
  });
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/** Alumnado rechaza: se liberan las unidades y la persona ve el motivo. */
function rechazar(id, { actor, motivo = null }) {
  const p = fila(id);
  exigirEstado(p, ['PENDIENTE_APROBACION'], p && `Esa solicitud ya estaba ${p.estado}`);
  db.prepare(`UPDATE prestamos SET estado = 'RECHAZADO', resuelto_por = ?, resuelto_en = ?, motivo_rechazo = ?
              WHERE id = ?`).run(actor, reloj.ahora(), motivo, id);
  eventos.registrar(eventos.TIPOS.SOLICITUD_RECHAZADA, {
    lockerId: p.locker_id, prestamoId: p.id, actor, detalle: motivo || `${p.cantidad} x ${p.descripcion_item}`,
  });
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/**
 * Cancela una reserva que todavia no se retiro. La puede cancelar su dueño
 * (asi el docente queda habilitado para otra) o Alumnado.
 */
function cancelar(id, { legajo = null, actor, motivo = null }) {
  const p = fila(id);
  exigirEstado(p, ['PENDIENTE_APROBACION', 'RESERVADO'], 'Solo se puede cancelar una reserva que todavía no se retiró');
  if (legajo && p.legajo_usuario !== legajo) throw new ErrorNegocio('Esa reserva no es tuya', 403);
  const locker = lockers.fila(p.locker_id);
  if (locker.op_prestamo_id === p.id)
    throw new ErrorNegocio('Hay una apertura en curso para esta reserva', 409);

  db.prepare(`UPDATE prestamos SET estado = 'CANCELADO', resuelto_por = ?, resuelto_en = ?, motivo_rechazo = ?
              WHERE id = ?`).run(actor, reloj.ahora(), motivo, id);
  eventos.registrar(eventos.TIPOS.RESERVA_CANCELADA, {
    lockerId: p.locker_id, prestamoId: p.id, actor, detalle: motivo || `${p.cantidad} x ${p.descripcion_item}`,
  });
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/* ============================================================
   3. TRANSICIONES FISICAS (las llama operacion.service)
   ============================================================ */

/** La puerta se cerro despues de un retiro: RESERVADO -> EN_USO. */
function marcarRetirado(id, { timestampRetiro }) {
  const p = fila(id);
  if (!p || p.estado !== 'RESERVADO') return null;
  db.prepare(`UPDATE prestamos SET estado = 'EN_USO', timestamp_retiro = ? WHERE id = ?`)
    .run(timestampRetiro || reloj.ahora(), id);
  eventos.registrar(eventos.TIPOS.RETIRO, {
    lockerId: p.locker_id, prestamoId: id, actor: p.legajo_usuario,
    detalle: `${p.cantidad} x ${p.descripcion_item} · devolver antes de ${p.hora_limite}`,
  });
  return emitir(id);
}

/**
 * La puerta se cerro despues de una devolucion. Modelo hibrido (spec 3.2):
 *
 *   Camino A  docente, <= 50% de la capacidad y en termino
 *             -> BUFFER_30_MIN y, a los 30 min, FINALIZADO solo.
 *   Camino B  alumno, > 50%, en mora, o material entregado por ventanilla
 *             -> PENDIENTE_AUDITORIA: las unidades no vuelven al stock
 *                hasta el "Confirmar Stock OK" de Alumnado.
 */
function registrarDevolucion(id, { enTermino }) {
  const p = fila(id);
  if (!p || !['EN_USO', 'EN_MORA'].includes(p.estado)) return null;

  const estandar =
    p.rol === 'docente' &&
    p.cantidad <= p.capacidad_maxima / 2 &&
    enTermino &&
    p.estado === 'EN_USO' &&
    !p.entregado_en_ventanilla;

  const nuevo = estandar ? 'BUFFER_30_MIN' : 'PENDIENTE_AUDITORIA';
  db.prepare(
    `UPDATE prestamos SET estado = ?, timestamp_devolucion = ?, devolucion_en_termino = ?, camino_devolucion = ?
     WHERE id = ?`
  ).run(nuevo, reloj.ahora(), enTermino ? 1 : 0, estandar ? 'A' : 'B', id);

  eventos.registrar(estandar ? eventos.TIPOS.DEVOLUCION_ESTANDAR : eventos.TIPOS.DEVOLUCION_CRITICA, {
    lockerId: p.locker_id, prestamoId: id, actor: p.legajo_usuario,
    detalle: `${p.cantidad} x ${p.descripcion_item}${enTermino ? '' : ' · fuera de término'}`,
  });

  if (!estandar) {
    alertar({
      tipo: 'AUDITORIA',
      nivel: NIVELES.ADVERTENCIA,
      mensaje: `Verificar reingreso físico en Locker ${p.locker_id}`,
      lockerId: p.locker_id,
      prestamoId: id,
    });
  }
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return prestamo;
}

/** Suma un intento de apertura para retirar (evita el no-show si la persona vino). */
const sumarIntento = (id) =>
  db.prepare(`UPDATE prestamos SET intentos_apertura = intentos_apertura + 1 WHERE id = ?`).run(id);

/* ============================================================
   4. ACCIONES DE ALUMNADO
   ============================================================ */

/**
 * "Confirmar Stock OK": Alumnado reviso el casillero.
 * Si faltan unidades se descuentan del stock fisico (no existen mas) y,
 * si Alumnado lo indica, se sanciona a quien devolvio.
 */
function confirmarAuditoria(id, { actor, unidadesRecibidas = null, sancionar = false }) {
  const p = fila(id);
  exigirEstado(p, ['PENDIENTE_AUDITORIA'], 'Ese préstamo no está esperando auditoría');

  const recibidas = unidadesRecibidas == null ? p.cantidad : Number(unidadesRecibidas);
  if (!Number.isInteger(recibidas) || recibidas < 0 || recibidas > p.cantidad)
    throw new ErrorNegocio(`Las unidades recibidas van de 0 a ${p.cantidad}`, 400);
  const faltan = p.cantidad - recibidas;

  db.transaction(() => {
    db.prepare(`UPDATE prestamos SET estado = 'FINALIZADO', auditado_por = ?, auditado_en = ?, unidades_recibidas = ?
                WHERE id = ?`).run(actor, reloj.ahora(), recibidas, id);
    if (faltan > 0)
      db.prepare(`UPDATE lockers SET stock_actual_fisico = MAX(0, stock_actual_fisico - ?) WHERE id = ?`)
        .run(faltan, p.locker_id);
  })();

  eventos.registrar(faltan ? eventos.TIPOS.AUDITORIA_CON_DIFERENCIA : eventos.TIPOS.AUDITORIA_OK, {
    lockerId: p.locker_id, prestamoId: id, actor,
    detalle: faltan
      ? `Faltan ${faltan} de ${p.cantidad} ${p.descripcion_item}: stock físico descontado`
      : `${p.cantidad} x ${p.descripcion_item} verificadas`,
  });
  if (faltan && sancionar)
    usuarios.sancionar(p.legajo_usuario, `Devolvió ${recibidas} de ${p.cantidad} en ${p.locker_id} (préstamo #${id})`, {
      actor, lockerId: p.locker_id, prestamoId: id,
    });

  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/**
 * Devolucion en mano en la ventanilla: Alumnado recibe y verifica en el acto,
 * por eso pasa directo a FINALIZADO. Si estaba en mora la sancion sigue.
 */
function devolucionVentanilla(id, { actor }) {
  const p = fila(id);
  exigirEstado(p, ['EN_USO', 'EN_MORA'], 'Ese préstamo no tiene material afuera');
  if (lockers.fila(p.locker_id).op_prestamo_id === p.id)
    throw new ErrorNegocio('Hay una devolución en curso en el locker', 409);

  const enTermino = reloj.ahoraMs() <= Date.parse(p.limite_ts);
  db.prepare(
    `UPDATE prestamos SET estado = 'FINALIZADO', timestamp_devolucion = ?, devolucion_en_termino = ?,
            auditado_por = ?, auditado_en = ?, unidades_recibidas = cantidad
     WHERE id = ?`
  ).run(reloj.ahora(), enTermino ? 1 : 0, actor, reloj.ahora(), id);
  eventos.registrar(eventos.TIPOS.DEVOLUCION_VENTANILLA, {
    lockerId: p.locker_id, prestamoId: id, actor, detalle: `${p.cantidad} x ${p.descripcion_item} de ${p.legajo_usuario}`,
  });
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/** Material de respaldo entregado en ventanilla (Fase 4.3, sin stock en ningun locker). */
function entregaVentanilla(id, { actor }) {
  const p = fila(id);
  exigirEstado(p, ['RESERVADO'], 'Solo se entrega por ventanilla una reserva vigente');
  db.prepare(`UPDATE prestamos SET estado = 'EN_USO', timestamp_retiro = ?, entregado_en_ventanilla = 1,
              requiere_respaldo = 0 WHERE id = ?`).run(reloj.ahora(), id);
  eventos.registrar(eventos.TIPOS.ENTREGA_VENTANILLA, {
    lockerId: p.locker_id, prestamoId: id, actor, detalle: `${p.cantidad} x ${p.descripcion_item} para ${p.legajo_usuario}`,
  });
  const prestamo = emitir(id);
  lockers.notificar(p.locker_id);
  return { prestamo };
}

/* ============================================================
   5. WATCHDOG
   ============================================================ */

/** Solicitudes que Alumnado no resolvio antes de que venciera la franja. */
function rechazarVencidas() {
  const limite = reloj.iso(reloj.ahoraMs() - R.toleranciaRetiroMin * MIN);
  const viejas = db
    .prepare(`SELECT id, locker_id FROM prestamos WHERE estado = 'PENDIENTE_APROBACION' AND inicio_ts < ?`)
    .all(limite);
  for (const p of viejas) {
    const motivo = 'Alumnado no la aprobó antes de que venciera la tolerancia de retiro';
    db.prepare(`UPDATE prestamos SET estado = 'RECHAZADO', resuelto_por = 'sistema', resuelto_en = ?, motivo_rechazo = ?
                WHERE id = ?`).run(reloj.ahora(), motivo, p.id);
    eventos.registrar(eventos.TIPOS.SOLICITUD_RECHAZADA, { lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog', detalle: motivo });
    emitir(p.id);
    lockers.notificar(p.locker_id);
  }
  return viejas.length;
}

/**
 * Escenario B (no-show): RESERVADO, pasaron los 15 min de tolerancia y nadie
 * abrio. Libera las unidades al instante e invalida el codigo.
 *
 * Si la persona SI vino (pidio al menos un pulso) pero la puerta no abrio,
 * no es un no-show: puede seguir reintentando hasta la hora limite.
 * Una reserva que espera material de respaldo tampoco se cancela.
 */
function cancelarNoShow() {
  const t = reloj.ahoraMs();
  const limiteTolerancia = reloj.iso(t - R.toleranciaRetiroMin * MIN);
  const candidatas = db
    .prepare(
      `SELECT p.id, p.locker_id, p.legajo_usuario, p.intentos_apertura, p.limite_ts, l.op_prestamo_id
       FROM prestamos p JOIN lockers l ON l.id = p.locker_id
       WHERE p.estado = 'RESERVADO' AND p.requiere_respaldo = 0 AND p.inicio_ts < ?`
    )
    .all(limiteTolerancia);

  let cambios = 0;
  for (const p of candidatas) {
    if (p.op_prestamo_id === p.id) continue;          // hay una apertura en curso
    if (p.intentos_apertura === 0) {
      db.prepare(`UPDATE prestamos SET estado = 'CANCELADO_NO_SHOW', resuelto_por = 'sistema', resuelto_en = ?
                  WHERE id = ?`).run(reloj.ahora(), p.id);
      eventos.registrar(eventos.TIPOS.NO_SHOW, {
        lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog',
        detalle: `${p.legajo_usuario} no retiró dentro de los ${R.toleranciaRetiroMin} min`,
      });
    } else if (Date.parse(p.limite_ts) <= t) {
      const motivo = 'La puerta nunca llegó a abrirse durante la franja';
      db.prepare(`UPDATE prestamos SET estado = 'CANCELADO', resuelto_por = 'sistema', resuelto_en = ?, motivo_rechazo = ?
                  WHERE id = ?`).run(reloj.ahora(), motivo, p.id);
      eventos.registrar(eventos.TIPOS.RESERVA_CANCELADA, { lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog', detalle: motivo });
    } else continue;
    cambios++;
    emitir(p.id);
    lockers.notificar(p.locker_id);
  }
  return cambios;
}

/**
 * Fase 4: EN_USO que llego a la hora limite -> EN_MORA + sancion automatica.
 * Si la persona ya valido su codigo y esta devolviendo, no se la sanciona.
 */
function marcarMora() {
  const vencidos = db
    .prepare(
      `SELECT p.id, p.locker_id, p.legajo_usuario, p.cantidad, p.descripcion_item, p.limite_ts, p.hora_limite,
              l.op_prestamo_id, l.op_tipo
       FROM prestamos p JOIN lockers l ON l.id = p.locker_id
       WHERE p.estado = 'EN_USO' AND p.limite_ts <= ?`
    )
    .all(reloj.ahora());

  let cambios = 0;
  for (const p of vencidos) {
    if (p.op_prestamo_id === p.id && p.op_tipo === 'DEVOLUCION') continue;
    db.prepare(`UPDATE prestamos SET estado = 'EN_MORA', mora_desde = ? WHERE id = ? AND estado = 'EN_USO'`)
      .run(p.limite_ts, p.id);
    eventos.registrar(eventos.TIPOS.MORA, {
      lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog',
      detalle: `${p.legajo_usuario} retiene ${p.cantidad} x ${p.descripcion_item} desde las ${p.hora_limite}`,
    });
    usuarios.sancionar(p.legajo_usuario, `Mora en préstamo #${p.id} (${p.locker_id})`, {
      actor: 'watchdog', lockerId: p.locker_id, prestamoId: p.id,
    });
    const prestamo = emitir(p.id);
    alertar(
      {
        tipo: 'MORA',
        nivel: NIVELES.CRITICA,
        mensaje: `${prestamo.usuario.nombre} (${p.legajo_usuario}) no devolvió ${p.cantidad} x ${p.descripcion_item} de ${p.locker_id}`,
        lockerId: p.locker_id,
        prestamoId: p.id,
      },
      { usuario: p.legajo_usuario }
    );
    lockers.notificar(p.locker_id);
    cambios++;
  }
  return cambios;
}

/** Camino A: a los 30 minutos de la devolucion las unidades vuelven solas. */
function liberarBuffers() {
  const limite = reloj.iso(reloj.ahoraMs() - R.bufferPosdevolucionMin * MIN);
  const listos = db
    .prepare(`SELECT id, locker_id FROM prestamos WHERE estado = 'BUFFER_30_MIN' AND timestamp_devolucion <= ?`)
    .all(limite);
  for (const p of listos) {
    db.prepare(`UPDATE prestamos SET estado = 'FINALIZADO' WHERE id = ?`).run(p.id);
    eventos.registrar(eventos.TIPOS.BUFFER_LIBERADO, { lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog' });
    emitir(p.id);
    lockers.notificar(p.locker_id);
  }
  return listos.length;
}

/**
 * Fase 4.3: a 15 minutos de cada turno se verifica que el locker pueda
 * cubrirlo. Si no alcanza (tipicamente porque el turno anterior sigue en
 * mora), se busca otro locker con el mismo material y se reasigna con un
 * codigo nuevo. Si no hay en ningun lado, se avisa a la persona y a
 * Alumnado para que entregue material de respaldo en ventanilla.
 */
function mitigarTurnos() {
  const t = reloj.ahoraMs();
  const proximas = db
    .prepare(
      `SELECT * FROM prestamos
       WHERE estado = 'RESERVADO' AND requiere_respaldo = 0 AND intentos_apertura = 0
         AND inicio_ts > ? AND inicio_ts <= ?
       ORDER BY inicio_ts, id`
    )
    .all(reloj.iso(t - R.toleranciaRetiroMin * MIN), reloj.iso(t + R.mitigacionAnticipacionMin * MIN));

  const resultado = { reasignadas: 0, respaldo: 0 };
  for (const p of proximas) {
    const desde = Date.parse(p.inicio_ts);
    const hasta = Date.parse(p.fin_buffer_ts);
    if (lockers.fila(p.locker_id).op_prestamo_id === p.id) continue;
    if (lockers.disponibleEnFranja(p.locker_id, desde, hasta, { excluirId: p.id }) >= p.cantidad) continue;

    const destino = lockers
      .conMismoMaterial(p.locker_id)
      .find((l) => lockers.disponibleEnFranja(l.id, desde, hasta) >= p.cantidad);

    if (destino) {
      const codigo = generarCodigo();
      db.prepare(`UPDATE prestamos SET locker_id = ?, locker_original_id = COALESCE(locker_original_id, ?),
                  codigo_operacion = ? WHERE id = ?`).run(destino.id, p.locker_id, codigo, p.id);
      eventos.registrar(eventos.TIPOS.REASIGNACION, {
        lockerId: destino.id, prestamoId: p.id, actor: 'watchdog',
        detalle: `${p.locker_id} -> ${destino.id}: el stock no alcanzaba para el turno de las ${p.hora_inicio}`,
      });
      emitir(p.id);
      alertar(
        {
          tipo: 'REASIGNACION',
          nivel: NIVELES.INFO,
          mensaje: `Tu reserva de las ${p.hora_inicio} pasó del locker ${p.locker_id} al ${destino.id}. Tenés un código nuevo.`,
          lockerId: destino.id,
          prestamoId: p.id,
        },
        { usuario: p.legajo_usuario }
      );
      lockers.notificar(p.locker_id);
      lockers.notificar(destino.id);
      resultado.reasignadas++;
    } else {
      db.prepare(`UPDATE prestamos SET requiere_respaldo = 1 WHERE id = ?`).run(p.id);
      eventos.registrar(eventos.TIPOS.SIN_STOCK_RESPALDO, {
        lockerId: p.locker_id, prestamoId: p.id, actor: 'watchdog',
        detalle: `No hay ${p.descripcion_item} libre para el turno de las ${p.hora_inicio}: entregar respaldo en ventanilla`,
      });
      emitir(p.id);
      alertar(
        {
          tipo: 'RESPALDO',
          nivel: NIVELES.CRITICA,
          mensaje: `Sin stock para la reserva #${p.id} de las ${p.hora_inicio} (${p.cantidad} x ${p.descripcion_item}). Entregar material de respaldo en ventanilla.`,
          lockerId: p.locker_id,
          prestamoId: p.id,
        },
        { usuario: p.legajo_usuario }
      );
      resultado.respaldo++;
    }
  }
  return resultado;
}

module.exports = {
  ESTADOS_VIGENTES, ESTADOS_CON_CODIGO,
  reglasPara, calcularFranja, validarFranja,
  mapear, fila, obtener, emitir, vigenteDe, porUsuario, historial, resumen,
  pendientesDeAprobacion, enMora, pendientesAuditoria, requierenRespaldo,
  solicitar, aprobar, rechazar, cancelar,
  marcarRetirado, registrarDevolucion, sumarIntento,
  confirmarAuditoria, devolucionVentanilla, entregaVentanilla,
  rechazarVencidas, cancelarNoShow, marcarMora, liberarBuffers, mitigarTurnos,
};
