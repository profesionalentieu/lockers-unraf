'use strict';
/**
 * Prestamos: solicitud, aprobacion, retiro y devolucion.
 *
 * CIRCUITO COMPLETO:
 *
 *   1. El usuario SOLICITA        -> 'pendiente'. NO se abre nada.
 *                                    El stock queda RESERVADO.
 *   2. Alumnado APRUEBA           -> 'aprobado' + se emite un CODIGO de 4
 *                                    digitos con 2 usos y 10 h de vigencia.
 *                                    Sigue sin abrirse nada: el material esta
 *                                    adentro y la persona puede estar lejos.
 *      o RECHAZA                  -> 'rechazado', se libera la reserva.
 *      o nadie contesta a tiempo  -> 'caducado' por watchdog, se libera.
 *   3. La persona va al locker, escanea el QR e ingresa el codigo:
 *      primer uso                 -> se abre la puerta y pasa a 'activo'
 *      segundo uso                -> se abre y pasa a 'devuelto'
 *
 * Por que el codigo hace las dos cosas: la persona memoriza uno solo para todo
 * el ciclo. La devolucion no necesita aprobacion de nadie, a proposito: trabar
 * la devolucion solo lograria que la gente se quede con el material. Lo que hay
 * que controlar es la salida, no la vuelta.
 *
 * La unica fuente de verdad del stock sigue siendo esta tabla: no hay ninguna
 * columna de stock que actualizar, asi que stock e historial no pueden
 * contradecirse (ver casillero.service.js).
 */
const { db, ahora } = require('../config/database');
const env = require('../config/env');
const { ErrorNegocio } = require('../utils/errores');
const hub = require('../realtime/hub');
const casilleros = require('./casillero.service');
const comandos = require('./comando.service');
const codigos = require('./codigo.service');
const eventos = require('./evento.service');

/** Limite de unidades por solicitud segun el rol. Evita que uno vacie el panol. */
const LIMITE_POR_RETIRO = { alumno: 5, docente: 25 };

/** Cuantas solicitudes sin resolver puede tener una persona a la vez. */
const MAX_SOLICITUDES_ABIERTAS = 3;

const buscarUsuarioPorLegajo = (legajo) =>
  db.prepare(`SELECT * FROM usuarios WHERE legajo = ? AND activo = 1`).get(String(legajo).trim());

/* ============================================================
   LECTURA
   ============================================================ */

const SQL_PRESTAMOS = `
  SELECT p.*, i.nombre AS item_nombre, i.codigo AS item_codigo, i.unidad,
         c.codigo AS casillero_codigo, c.id AS casillero_id_real,
         u.legajo, u.nombre AS usuario_nombre, u.rol
  FROM prestamos p
  JOIN items i      ON i.id = p.item_id
  JOIN casilleros c ON c.id = p.casillero_id
  JOIN usuarios u   ON u.id = p.usuario_id
`;

const mapear = (fila) => ({
  id: fila.id,
  estado: fila.estado,
  vencido: Boolean(fila.vencido),
  cantidad: fila.cantidad,
  cantidadDevuelta: fila.cantidad_devuelta,
  pendiente: fila.cantidad - fila.cantidad_devuelta,
  solicitadoEn: fila.solicitado_en,
  retiradoEn: fila.retirado_en,
  vencimiento: fila.vencimiento,
  devueltoEn: fila.devuelto_en,
  resueltoPor: fila.resuelto_por,
  resueltoEn: fila.resuelto_en,
  motivoRechazo: fila.motivo_rechazo,
  codigo: fila.codigo || null,
  codigoUsos: fila.codigo_usos,
  codigoUsosRestantes: fila.codigo ? fila.codigo_max_usos - fila.codigo_usos : 0,
  codigoExpira: fila.codigo_expira,
  codigoVencido: Boolean(
    fila.codigo_expira && Date.parse(fila.codigo_expira) < Date.now()
  ),
  // Minutos que lleva esperando: le sirve a Alumnado para priorizar la cola.
  minutosEsperando:
    fila.estado === 'pendiente'
      ? Math.round((Date.now() - Date.parse(fila.solicitado_en)) / 60000)
      : null,
  horasRestantes: fila.vencimiento
    ? Math.round((Date.parse(fila.vencimiento) - Date.now()) / 36e5)
    : null,
  item: { id: fila.item_id, nombre: fila.item_nombre, codigo: fila.item_codigo, unidad: fila.unidad },
  casillero: { id: fila.casillero_id, codigo: fila.casillero_codigo },
  usuario: { legajo: fila.legajo, nombre: fila.usuario_nombre, rol: fila.rol },
});

const obtener = (id) => {
  const fila = db.prepare(`${SQL_PRESTAMOS} WHERE p.id = ?`).get(id);
  return fila ? mapear(fila) : null;
};

/** Cola de aprobacion: lo que Alumnado tiene que resolver, mas viejo primero. */
const pendientesDeAprobacion = () =>
  db.prepare(`${SQL_PRESTAMOS} WHERE p.estado = 'pendiente' ORDER BY p.solicitado_en ASC`)
    .all()
    .map(mapear);

/* ============================================================
   1. SOLICITUD
   ============================================================ */

/**
 * Registra una solicitud de retiro. NO abre ningun casillero.
 *
 * La validacion de stock y el INSERT van en la MISMA transaccion: si dos
 * personas piden la ultima notebook con medio segundo de diferencia, la
 * segunda encuentra el stock ya reservado y recibe el error, en vez de que
 * las dos queden con una solicitud valida sobre una notebook que no existe.
 *
 * @returns {{prestamo:object}}
 */
function solicitar({ legajo, casilleroId, cantidad }) {
  const usuario = buscarUsuarioPorLegajo(legajo);
  if (!usuario) throw new ErrorNegocio('Usuario no encontrado', 404);

  const pedido = Number(cantidad);
  if (!Number.isInteger(pedido) || pedido <= 0)
    throw new ErrorNegocio('La cantidad tiene que ser un numero entero mayor a cero', 400);

  const limite = LIMITE_POR_RETIRO[usuario.rol] ?? 5;
  if (pedido > limite)
    throw new ErrorNegocio(`Podes pedir hasta ${limite} unidades por vez`, 400);

  const transaccion = db.transaction(() => {
    // Tope de solicitudes abiertas: sin esto, alguien puede reservar todo el
    // panol con pedidos que nunca va a retirar.
    const abiertas = db
      .prepare(`SELECT COUNT(*) AS n FROM prestamos WHERE usuario_id = ? AND estado = 'pendiente'`)
      .get(usuario.id).n;
    if (abiertas >= MAX_SOLICITUDES_ABIERTAS)
      throw new ErrorNegocio(
        `Ya tenes ${abiertas} solicitudes esperando aprobacion. Espera a que Alumnado las resuelva.`,
        409
      );

    const casillero = casilleros.obtener(casilleroId);
    if (!casillero) throw new ErrorNegocio('El casillero no existe', 404);
    if (!casillero.item) throw new ErrorNegocio('Ese casillero no tiene material cargado', 409);
    if (casillero.estado === casilleros.ESTADOS.ERROR)
      throw new ErrorNegocio(`${casillero.codigo} esta fuera de servicio`, 409);
    if (pedido > casillero.inventario.disponible)
      throw new ErrorNegocio(
        `Quedan ${casillero.inventario.disponible} ${casillero.item.unidad}(s) de ${casillero.item.nombre}`,
        409
      );

    const info = db
      .prepare(
        `INSERT INTO prestamos
           (usuario_id, casillero_id, item_id, cantidad, estado, solicitado_en)
         VALUES (?, ?, ?, ?, 'pendiente', ?)`
      )
      .run(usuario.id, casillero.id, casillero.item.id, pedido, ahora());

    return { prestamoId: Number(info.lastInsertRowid), casillero };
  });

  const { prestamoId, casillero } = transaccion();
  const prestamo = obtener(prestamoId);

  eventos.registrar(eventos.TIPOS.SOLICITUD, {
    casilleroId: casillero.id,
    prestamoId,
    actor: usuario.legajo,
    detalle: `${pedido} x ${casillero.item.nombre}`,
  });

  // El panel de Alumnado tiene que ver la solicitud sin refrescar.
  hub.emitir('solicitud.nueva', prestamo, ['admin']);
  casilleros.notificar(casillero.id);

  return { prestamo };
}

/* ============================================================
   2. APROBACION / RECHAZO
   ============================================================ */

/**
 * Alumnado aprueba: se emite el codigo y se reserva el material.
 * NO se abre el casillero: eso ocurre cuando la persona usa el codigo.
 *
 * @returns {{prestamo:object}} con el codigo adentro
 */
function aprobar(prestamoId, { actor }) {
  const transaccion = db.transaction(() => {
    const prestamo = obtener(prestamoId);
    if (!prestamo) throw new ErrorNegocio('La solicitud no existe', 404);
    if (prestamo.estado !== 'pendiente')
      throw new ErrorNegocio(`Esa solicitud ya estaba ${prestamo.estado}`, 409);

    const casillero = casilleros.obtener(prestamo.casillero.id);
    if (casillero.estado === casilleros.ESTADOS.ERROR)
      throw new ErrorNegocio(`${casillero.codigo} esta fuera de servicio`, 409);

    // El stock ya estaba reservado por esta solicitud: solo confirmamos que
    // el total no se haya recortado por debajo de lo comprometido.
    if (casillero.inventario.total < casillero.inventario.prestado + prestamo.cantidad)
      throw new ErrorNegocio('El stock del casillero cambio: revisa el inventario', 409);

    const codigo = codigos.generar(casillero.id);
    db.prepare(
      `UPDATE prestamos
       SET estado = 'aprobado', resuelto_por = ?, resuelto_en = ?,
           codigo = ?, codigo_usos = 0, codigo_expira = ?
       WHERE id = ?`
    ).run(actor, ahora(), codigo, codigos.vencimiento(), prestamoId);

    return prestamo;
  });

  const previo = transaccion();

  eventos.registrar(eventos.TIPOS.SOLICITUD_APROBADA, {
    casilleroId: previo.casillero.id,
    prestamoId,
    actor,
    detalle: `${previo.cantidad} x ${previo.item.nombre} para ${previo.usuario.legajo}`,
  });

  const prestamo = obtener(prestamoId);
  avisarAlUsuario(prestamo, 'solicitud.resuelta', {});
  hub.emitir('solicitud.resuelta', prestamo, ['admin']);
  casilleros.notificar(previo.casillero.id);

  return { prestamo };
}

/* ============================================================
   USO DEL CODIGO EN EL LOCKER
   ============================================================ */

/**
 * Alguien ingreso un codigo en la pagina a la que lleva el QR del locker.
 * Valida, abre la puerta y hace avanzar el prestamo:
 *   primer uso  -> 'activo'   (retiro el material)
 *   segundo uso -> 'devuelto' (lo guardo)
 *
 * @param {string} casilleroCodigo  'A-01', viene en la URL del QR
 * @param {string} codigo           4 digitos
 * @param {string} origen           IP del cliente, para el control de intentos
 */
function usarCodigo(casilleroCodigo, codigo, origen) {
  // validar() ya rechaza codigo vencido, agotado, casillero en error y
  // puerta abierta, y registra el intento para el control de fuerza bruta.
  const crudo = codigos.validar(casilleroCodigo, codigo, origen);

  const esRetiro = crudo.estado === 'aprobado';
  const horas = crudo.rol === 'docente' ? 168 : 24;

  const transaccion = db.transaction(() => {
    if (esRetiro) {
      db.prepare(
        `UPDATE prestamos SET estado = 'activo', retirado_en = ?, vencimiento = ? WHERE id = ?`
      ).run(ahora(), new Date(Date.now() + horas * 36e5).toISOString(), crudo.id);
    } else {
      // Segundo uso: se devuelve todo lo pendiente de una vez.
      db.prepare(
        `UPDATE prestamos
         SET cantidad_devuelta = cantidad, estado = 'devuelto', devuelto_en = ?
         WHERE id = ?`
      ).run(ahora(), crudo.id);
    }
    return codigos.consumirUso(crudo.id);
  });

  const usosRestantes = transaccion();

  eventos.registrar(esRetiro ? eventos.TIPOS.RETIRO : eventos.TIPOS.DEVOLUCION, {
    casilleroId: crudo.casillero_id,
    prestamoId: crudo.id,
    actor: crudo.legajo,
    detalle: `${crudo.cantidad} x ${crudo.item_nombre} (codigo en el locker)`,
  });

  const comando = comandos.encolarApertura(crudo.casillero_id, {
    origen: 'usuario',
    solicitadoPor: crudo.legajo,
    motivo: esRetiro ? 'RETIRO' : 'DEVOLUCION',
    prestamoId: crudo.id,
  });

  const prestamo = obtener(crudo.id);
  avisarAlUsuario(prestamo, 'prestamo.actualizado', { comandoId: comando.id });
  hub.emitir('prestamo.actualizado', prestamo, ['admin']);
  casilleros.notificar(crudo.casillero_id);

  return {
    accion: esRetiro ? 'RETIRO' : 'DEVOLUCION',
    usosRestantes,
    comandoId: comando.id,
    casillero: crudo.casillero_codigo,
    item: crudo.item_nombre,
    cantidad: crudo.cantidad,
    usuario: crudo.usuario_nombre,
  };
}

/** Alumnado rechaza: se libera la reserva y el usuario se entera al instante. */
function rechazar(prestamoId, { actor, motivo = null }) {
  const prestamo = obtener(prestamoId);
  if (!prestamo) throw new ErrorNegocio('La solicitud no existe', 404);
  if (prestamo.estado !== 'pendiente')
    throw new ErrorNegocio(`Esa solicitud ya estaba ${prestamo.estado}`, 409);

  db.prepare(
    `UPDATE prestamos
     SET estado = 'rechazado', resuelto_por = ?, resuelto_en = ?, motivo_rechazo = ?,
         codigo = NULL
     WHERE id = ?`
  ).run(actor, ahora(), motivo, prestamoId);

  eventos.registrar(eventos.TIPOS.SOLICITUD_RECHAZADA, {
    casilleroId: prestamo.casillero.id,
    prestamoId,
    actor,
    detalle: motivo || `${prestamo.cantidad} x ${prestamo.item.nombre}`,
  });

  const actualizado = obtener(prestamoId);
  avisarAlUsuario(actualizado, 'solicitud.resuelta', {});
  hub.emitir('solicitud.resuelta', actualizado, ['admin']);
  casilleros.notificar(prestamo.casillero.id);   // se libero la reserva

  return { prestamo: actualizado };
}

/**
 * Watchdog: cierra lo que quedo colgado y libera el stock reservado.
 * Dos casos, los dos con el material todavia adentro del casillero:
 *   · solicitudes que nadie aprobo a tiempo
 *   · codigos emitidos que vencieron sin que la persona fuera a retirar
 */
function caducarSolicitudes() {
  const limite = new Date(Date.now() - env.reglas.solicitudCaducaMin * 60000).toISOString();
  const viejas = db
    .prepare(`SELECT id FROM prestamos WHERE estado = 'pendiente' AND solicitado_en < ?`)
    .all(limite)
    .concat(codigos.caducarCodigosSinUsar().map((id) => ({ id })));

  for (const fila of viejas) {
    const prestamo = obtener(fila.id);
    db.prepare(
      `UPDATE prestamos SET estado = 'caducado', resuelto_por = 'sistema', resuelto_en = ?,
                            codigo = NULL
       WHERE id = ?`
    ).run(ahora(), fila.id);

    eventos.registrar(eventos.TIPOS.SOLICITUD_CADUCADA, {
      casilleroId: prestamo.casillero.id,
      prestamoId: fila.id,
      actor: 'watchdog',
      detalle: prestamo.estado === 'aprobado'
        ? `codigo vencido sin usarse (${env.reglas.codigoVigenciaHoras} h)`
        : `sin aprobar por mas de ${env.reglas.solicitudCaducaMin} min`,
    });

    const actualizado = obtener(fila.id);
    avisarAlUsuario(actualizado, 'solicitud.resuelta', {});
    hub.emitir('solicitud.resuelta', actualizado, ['admin']);
    casilleros.notificar(prestamo.casillero.id);
  }
  return viejas.length;
}

/* ============================================================
   3. DEVOLUCION
   ============================================================ */

/**
 * Devolucion registrada desde el panel de Alumnado ("por mostrador"): alguien
 * trajo el material en mano, o se recupero de un prestamo vencido.
 *
 * El camino normal de devolucion NO pasa por aca: es el segundo uso del codigo
 * en el locker (ver usarCodigo). Esta funcion existe para los casos en que la
 * persona perdio el codigo, se le vencio, o devuelve solo una parte.
 */
function devolver(prestamoId, { legajo = null, cantidad = null, actor = null } = {}) {
  const transaccion = db.transaction(() => {
    const prestamo = obtener(prestamoId);
    if (!prestamo) throw new ErrorNegocio('El prestamo no existe', 404);
    if (prestamo.estado === 'pendiente')
      throw new ErrorNegocio('Esa solicitud todavia no fue aprobada', 409);
    if (prestamo.estado === 'aprobado')
      throw new ErrorNegocio('Todavia no retiro el material: no hay nada que devolver', 409);
    if (prestamo.estado !== 'activo') throw new ErrorNegocio('Ese prestamo ya fue devuelto', 409);

    // Un usuario solo puede devolver lo suyo; el admin puede devolver cualquiera.
    if (legajo && prestamo.usuario.legajo !== legajo)
      throw new ErrorNegocio('Ese prestamo no es tuyo', 403);

    const aDevolver = cantidad === null ? prestamo.pendiente : Number(cantidad);
    if (!Number.isInteger(aDevolver) || aDevolver <= 0)
      throw new ErrorNegocio('La cantidad a devolver tiene que ser mayor a cero', 400);
    if (aDevolver > prestamo.pendiente)
      throw new ErrorNegocio(`Solo tenes ${prestamo.pendiente} sin devolver`, 400);

    const totalDevuelto = prestamo.cantidadDevuelta + aDevolver;
    const completo = totalDevuelto === prestamo.cantidad;

    db.prepare(
      `UPDATE prestamos SET cantidad_devuelta = ?, estado = ?, devuelto_en = ? WHERE id = ?`
    ).run(totalDevuelto, completo ? 'devuelto' : 'activo', completo ? ahora() : null, prestamoId);

    return { prestamo, devuelto: aDevolver, completo };
  });

  const { prestamo, devuelto, completo } = transaccion();

  eventos.registrar(completo ? eventos.TIPOS.DEVOLUCION : eventos.TIPOS.DEVOLUCION_PARCIAL, {
    casilleroId: prestamo.casillero.id,
    prestamoId,
    actor: actor || prestamo.usuario.legajo,
    detalle: `${devuelto} x ${prestamo.item.nombre}`,
  });

  const comando = comandos.encolarApertura(prestamo.casillero.id, {
    origen: actor && !legajo ? 'admin' : 'usuario',
    solicitadoPor: actor || prestamo.usuario.legajo,
    motivo: 'DEVOLUCION',
    prestamoId,
  });

  casilleros.notificar(prestamo.casillero.id);
  return { prestamo: obtener(prestamoId), comandoId: comando.id };
}

/* ============================================================
   CONSULTAS
   ============================================================ */

/** Avisa por WebSocket a la persona duena del prestamo, no a todos. */
function avisarAlUsuario(prestamo, evento, extra) {
  hub.emitirA(prestamo.usuario.legajo, evento, { ...prestamo, ...extra });
}

/** Prestamos de una persona. `estado`: 'pendiente' | 'activo' | 'devuelto' | 'todos'. */
function porUsuario(legajo, estado = 'todos') {
  const filtro = estado === 'todos' ? '' : ' AND p.estado = ?';
  const parametros = estado === 'todos' ? [legajo] : [legajo, estado];
  return db
    .prepare(`${SQL_PRESTAMOS} WHERE u.legajo = ?${filtro} ORDER BY p.solicitado_en DESC`)
    .all(...parametros)
    .map(mapear);
}

/** Trazabilidad para Alumnado: quien, que, cuanto, cuando y quien lo aprobo. */
function historial({ estado = 'todos', buscar = '', limite = 100 } = {}) {
  const condiciones = [];
  const parametros = [];

  if (estado !== 'todos') { condiciones.push('p.estado = ?'); parametros.push(estado); }
  if (buscar.trim()) {
    condiciones.push('(u.legajo LIKE ? OR u.nombre LIKE ? OR i.nombre LIKE ?)');
    const patron = `%${buscar.trim()}%`;
    parametros.push(patron, patron, patron);
  }

  const where = condiciones.length ? ` WHERE ${condiciones.join(' AND ')}` : '';
  parametros.push(limite);

  return db
    .prepare(`${SQL_PRESTAMOS}${where} ORDER BY p.solicitado_en DESC LIMIT ?`)
    .all(...parametros)
    .map(mapear);
}

/** Resumen para el encabezado del panel. */
function resumen() {
  const fila = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE estado = 'pendiente')              AS solicitudes,
         COUNT(*) FILTER (WHERE estado = 'aprobado')               AS esperando_retiro,
         COUNT(*) FILTER (WHERE estado = 'activo')                 AS prestamos_activos,
         COALESCE(SUM(CASE WHEN estado = 'activo'
                           THEN cantidad - cantidad_devuelta END), 0) AS unidades_afuera,
         COUNT(*) FILTER (WHERE estado = 'activo' AND vencido = 1) AS vencidos
       FROM prestamos`
    )
    .get();
  return {
    solicitudesPendientes: fila.solicitudes,
    esperandoRetiro: fila.esperando_retiro,
    prestamosActivos: fila.prestamos_activos,
    unidadesAfuera: fila.unidades_afuera,
    vencidos: fila.vencidos,
  };
}

/**
 * Watchdog: marca vencidos los prestamos fuera de plazo.
 * No los cierra solo: hay material fisico afuera, y darlo por devuelto seria
 * inventar stock que no volvio. Se marca y Alumnado reclama.
 */
function marcarVencidos() {
  const info = db
    .prepare(
      `UPDATE prestamos SET vencido = 1
       WHERE estado = 'activo' AND vencido = 0 AND vencimiento IS NOT NULL AND vencimiento < ?`
    )
    .run(ahora());
  return info.changes;
}

module.exports = {
  LIMITE_POR_RETIRO, MAX_SOLICITUDES_ABIERTAS,
  solicitar, aprobar, rechazar, devolver, usarCodigo,
  obtener, pendientesDeAprobacion, porUsuario, historial, resumen,
  marcarVencidos, caducarSolicitudes, buscarUsuarioPorLegajo,
};
