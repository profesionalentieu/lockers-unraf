'use strict';
/**
 * Lockers + stock por franja horaria.
 *
 * LA REGLA CENTRAL (spec 2.2): el bloqueo se aplica sobre las UNIDADES, no
 * sobre el locker. Lo que se puede reservar en una franja se deriva:
 *
 *     disponible(franja) = stock_actual_fisico - pico de unidades bloqueadas
 *                                                dentro de la franja
 *
 * Cada prestamo bloquea sus unidades durante un intervalo que depende de su
 * estado:
 *
 *   PENDIENTE_APROBACION, RESERVADO, EN_USO   [inicio, limite + 30 min]
 *   BUFFER_30_MIN                             [inicio, devolucion + 30 min]
 *   EN_MORA                                   [inicio, ...)   sin fin: no volvio
 *   PENDIENTE_AUDITORIA                       [inicio, ...)   hasta el OK de Alumnado
 *   el resto                                  no bloquea
 *
 * Se usa el PICO y no la suma de todo lo que se superpone: dos reservas que
 * se tocan con la franja pedida pero no entre si no compiten por las mismas
 * unidades. Con el ejemplo de la spec (25 notebooks, el docente 1 reserva 5
 * de 15:00 a 18:00), a las 16:00 quedan 20 para el resto.
 */
const { db } = require('../config/database');
const env = require('../config/env');
const reloj = require('../utils/reloj');
const hub = require('../realtime/hub');
const { ErrorNegocio } = require('../utils/errores');

const ESTADOS_QUE_BLOQUEAN = [
  'PENDIENTE_APROBACION', 'RESERVADO', 'EN_USO', 'EN_MORA', 'PENDIENTE_AUDITORIA', 'BUFFER_30_MIN',
];

const ESTADOS_LOCKER = {
  DISPONIBLE: 'DISPONIBLE',
  SIN_STOCK: 'SIN_STOCK',
  EN_OPERACION: 'EN_OPERACION',
  PUERTA_ABIERTA: 'PUERTA_ABIERTA',
  ERROR: 'ERROR',
};

const BUFFER_MS = () => env.reglas.bufferPosdevolucionMin * 60000;

/* ============================================================
   Intervalos de bloqueo
   ============================================================ */

/** [desde, hasta) en ms del intervalo que bloquea un prestamo, o null. */
function intervaloBloqueo(p) {
  const desde = Date.parse(p.inicio_ts);
  switch (p.estado) {
    case 'PENDIENTE_APROBACION':
    case 'RESERVADO':
    case 'EN_USO':
      return [desde, Date.parse(p.fin_buffer_ts)];
    case 'BUFFER_30_MIN': {
      const devuelto = p.timestamp_devolucion ? Date.parse(p.timestamp_devolucion) : Date.parse(p.limite_ts);
      return [desde, devuelto + BUFFER_MS()];
    }
    case 'EN_MORA':
    case 'PENDIENTE_AUDITORIA':
      return [desde, Infinity];
    default:
      return null;
  }
}

const SQL_BLOQUEANTES = `
  SELECT id, estado, cantidad, inicio_ts, limite_ts, fin_buffer_ts, timestamp_devolucion
  FROM prestamos
  WHERE locker_id = ? AND estado IN (${ESTADOS_QUE_BLOQUEAN.map(() => '?').join(',')})`;

const prestamosQueBloquean = (lockerId) =>
  db.prepare(SQL_BLOQUEANTES).all(lockerId, ...ESTADOS_QUE_BLOQUEAN);

/**
 * Pico de unidades bloqueadas al mismo tiempo dentro de [desde, hasta).
 * Barrido simple: el maximo solo puede ocurrir al comienzo de la franja o
 * cuando empieza algun intervalo adentro de ella.
 */
function picoOcupacion(prestamos, desde, hasta, excluirId = null) {
  const intervalos = prestamos
    .filter((p) => p.id !== excluirId)
    .map((p) => ({ cantidad: p.cantidad, rango: intervaloBloqueo(p) }))
    .filter((x) => x.rango && x.rango[0] < hasta && x.rango[1] > desde);

  const puntos = [desde, ...intervalos.map((x) => x.rango[0]).filter((t) => t > desde && t < hasta)];
  let pico = 0;
  for (const t of puntos) {
    const suma = intervalos
      .filter((x) => x.rango[0] <= t && t < x.rango[1])
      .reduce((total, x) => total + x.cantidad, 0);
    pico = Math.max(pico, suma);
  }
  return pico;
}

/** Unidades reservables de un locker en la franja [desde, hasta). */
function disponibleEnFranja(lockerId, desde, hasta, { excluirId = null } = {}) {
  const locker = db.prepare(`SELECT stock_actual_fisico FROM lockers WHERE id = ?`).get(lockerId);
  if (!locker) return 0;
  const pico = picoOcupacion(prestamosQueBloquean(lockerId), desde, hasta, excluirId);
  return Math.max(0, locker.stock_actual_fisico - pico);
}

/** Foto del inventario en este instante, desglosada por motivo. */
function ocupacionAhora(lockerId, stock) {
  const t = reloj.ahoraMs();
  const resultado = { enUso: 0, reservado: 0, enAuditoria: 0, enBuffer: 0, enMora: 0 };
  for (const p of prestamosQueBloquean(lockerId)) {
    const rango = intervaloBloqueo(p);
    if (!rango || !(rango[0] <= t && t < rango[1])) continue;
    if (p.estado === 'EN_USO') resultado.enUso += p.cantidad;
    else if (p.estado === 'EN_MORA') resultado.enMora += p.cantidad;
    else if (p.estado === 'PENDIENTE_AUDITORIA') resultado.enAuditoria += p.cantidad;
    else if (p.estado === 'BUFFER_30_MIN') resultado.enBuffer += p.cantidad;
    else resultado.reservado += p.cantidad;
  }
  const bloqueado = Object.values(resultado).reduce((a, b) => a + b, 0);
  return { ...resultado, disponibleAhora: Math.max(0, stock - bloqueado) };
}

/* ============================================================
   Lectura
   ============================================================ */

const SQL_LOCKERS = `
  SELECT l.*, n.codigo AS nodo, n.ubicacion, n.rssi, n.ultimo_contacto
  FROM lockers l
  LEFT JOIN nodos n ON n.id = l.nodo_id
`;

function mapear(fila) {
  const ocupacion = ocupacionAhora(fila.id, fila.stock_actual_fisico);

  let estado = ESTADOS_LOCKER.DISPONIBLE;
  if (fila.estado_operativo === 'error') estado = ESTADOS_LOCKER.ERROR;
  else if (fila.estado_puerta === 'ABIERTO') estado = ESTADOS_LOCKER.PUERTA_ABIERTA;
  else if (fila.op_tipo) estado = ESTADOS_LOCKER.EN_OPERACION;
  else if (ocupacion.disponibleAhora === 0) estado = ESTADOS_LOCKER.SIN_STOCK;

  const offline =
    !fila.ultimo_contacto ||
    (reloj.ahoraMs() - Date.parse(fila.ultimo_contacto)) / 1000 > env.reglas.nodoOfflineSeg;

  const segundosAbierta = fila.abierta_desde
    ? Math.round((reloj.ahoraMs() - Date.parse(fila.abierta_desde)) / 1000)
    : null;

  return {
    id: fila.id,
    descripcionItem: fila.descripcion_item,
    categoria: fila.categoria || 'General',
    capacidadMaxima: fila.capacidad_maxima,
    stockActualFisico: fila.stock_actual_fisico,
    estadoPuerta: fila.estado_puerta,
    estado,
    detalleError: fila.detalle_error || null,
    abiertaDesde: fila.abierta_desde,
    segundosAbierta,
    alertaPuertaAbierta: Boolean(fila.alerta_puerta_enviada),
    bitRegistro: fila.bit_registro,
    nodo: { codigo: fila.nodo, ubicacion: fila.ubicacion, rssi: fila.rssi, offline },
    inventario: { stock: fila.stock_actual_fisico, capacidad: fila.capacidad_maxima, ...ocupacion },
    operacion: fila.op_tipo
      ? {
          tipo: fila.op_tipo,
          prestamoId: fila.op_prestamo_id,
          legajo: fila.op_legajo,
          iniciadaEn: fila.op_iniciada_en,
          pulsoHasta: fila.op_pulso_hasta,
          comandoId: fila.op_comando_id,
          abrio: Boolean(fila.op_abrio),
        }
      : null,
  };
}

const listar = () => db.prepare(`${SQL_LOCKERS} ORDER BY l.id`).all().map(mapear);

const obtener = (id) => {
  const fila = db.prepare(`${SQL_LOCKERS} WHERE l.id = ?`).get(String(id || '').toUpperCase());
  return fila ? mapear(fila) : null;
};

/** Fila cruda: la usan los servicios que necesitan las columnas op_*. */
const fila = (id) => db.prepare(`SELECT * FROM lockers WHERE id = ?`).get(id);

/** Descripcion normalizada: es como se reconoce "el mismo tipo de material". */
const normalizar = (texto) =>
  String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();

/** Otros lockers que guardan el mismo material, operativos. */
const conMismoMaterial = (lockerId) => {
  const origen = fila(lockerId);
  if (!origen) return [];
  const clave = normalizar(origen.descripcion_item);
  return db
    .prepare(`SELECT * FROM lockers WHERE id <> ? AND estado_operativo = 'ok' ORDER BY id`)
    .all(lockerId)
    .filter((l) => normalizar(l.descripcion_item) === clave);
};

/* ============================================================
   Escritura (Alumnado)
   ============================================================ */

function marcarOperativo(lockerId, ok, detalle = null) {
  db.prepare(`UPDATE lockers SET estado_operativo = ?, detalle_error = ? WHERE id = ?`)
    .run(ok ? 'ok' : 'error', ok ? null : detalle, lockerId);
}

/**
 * Define que guarda el locker, su capacidad y cuantas unidades tiene.
 * El stock fisico no puede quedar por debajo de lo que esta afuera ahora
 * (en uso, en mora o esperando auditoria): esas unidades existen.
 */
function configurar(lockerId, { descripcionItem, categoria, capacidadMaxima, stockActualFisico }) {
  const actual = fila(lockerId);
  if (!actual) throw new ErrorNegocio('El locker no existe', 404);

  const descripcion = String(descripcionItem ?? actual.descripcion_item).trim();
  const capacidad = Number(capacidadMaxima ?? actual.capacidad_maxima);
  const stock = Number(stockActualFisico ?? actual.stock_actual_fisico);

  if (descripcion.length < 2) throw new ErrorNegocio('Cargá la descripción del material', 400);
  if (!Number.isInteger(capacidad) || capacidad < 1)
    throw new ErrorNegocio('La capacidad máxima tiene que ser un entero mayor a cero', 400);
  if (!Number.isInteger(stock) || stock < 0)
    throw new ErrorNegocio('El stock físico tiene que ser un entero mayor o igual a cero', 400);
  if (stock > capacidad)
    throw new ErrorNegocio(`El stock (${stock}) no puede superar la capacidad (${capacidad})`, 400);

  const ocupacion = ocupacionAhora(lockerId, actual.stock_actual_fisico);
  const afuera = ocupacion.enUso + ocupacion.enMora + ocupacion.enAuditoria;
  if (stock < afuera)
    throw new ErrorNegocio(`Hay ${afuera} unidades fuera o sin auditar: el stock no puede ser menor`, 409);

  const cambiaMaterial = normalizar(descripcion) !== normalizar(actual.descripcion_item);
  if (cambiaMaterial) {
    const vigentes = db
      .prepare(`SELECT COUNT(*) AS n FROM prestamos WHERE locker_id = ? AND estado IN
                ('PENDIENTE_APROBACION','RESERVADO','EN_USO','EN_MORA','PENDIENTE_AUDITORIA')`)
      .get(lockerId).n;
    if (vigentes)
      throw new ErrorNegocio('No se puede cambiar el material con reservas o préstamos vigentes', 409);
  }

  db.prepare(
    `UPDATE lockers SET descripcion_item = ?, categoria = ?, capacidad_maxima = ?, stock_actual_fisico = ?
     WHERE id = ?`
  ).run(descripcion, String(categoria ?? actual.categoria ?? 'General').trim() || 'General', capacidad, stock, lockerId);

  return obtener(lockerId);
}

/** Empuja el estado nuevo a los navegadores (panel, app y pantalla del locker). */
function notificar(lockerId) {
  const locker = obtener(lockerId);
  if (!locker) return;
  hub.emitir('locker.actualizado', locker, ['admin', 'usuario']);
  hub.emitirALocker(lockerId, 'locker.actualizado', locker);
}

module.exports = {
  ESTADOS_LOCKER, ESTADOS_QUE_BLOQUEAN,
  intervaloBloqueo, picoOcupacion, disponibleEnFranja, ocupacionAhora,
  listar, obtener, fila, mapear, normalizar, conMismoMaterial,
  marcarOperativo, configurar, notificar,
};
