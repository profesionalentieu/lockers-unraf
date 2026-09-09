'use strict';
/**
 * Códigos de apertura.
 *
 * Cómo funciona el circuito nuevo:
 *
 *   1. Alumnado aprueba  -> se emite un código de 4 dígitos con 2 usos y
 *                           10 h de vigencia. NO se abre nada todavía.
 *   2. La persona va al locker, escanea el QR pegado en la puerta (que lleva
 *      el casillero en la URL) e ingresa su código.
 *   3. Primer uso  -> se abre la puerta y el préstamo pasa a 'activo' (retiró).
 *   4. Segundo uso -> se abre otra vez y el préstamo pasa a 'devuelto'.
 *
 * DECISIONES QUE VALE LA PENA DEFENDER
 *
 * · El código se valida junto con el casillero, no solo. El QR de A-01 lleva
 *   `?casillero=A-01`, así que un código sirve únicamente en su locker. Eso
 *   resuelve el caso de dos personas pidiendo material distinto al mismo
 *   tiempo, y reduce la superficie de ataque: adivinar 4 dígitos solo sirve
 *   contra un casillero puntual.
 *
 * · 4 dígitos son 10.000 combinaciones. Sin protección se rompen a fuerza
 *   bruta en minutos, así que hay límite de intentos fallidos por casillero
 *   con bloqueo temporal. Sigue siendo un mecanismo débil comparado con un
 *   login: es una comodidad para el prototipo, no una medida de seguridad.
 *
 * · Los dos usos son deliberadamente el mismo código: la persona memoriza uno
 *   solo para todo el ciclo. La contra es que si alguien lo ve, puede abrir el
 *   locker una vez más; por eso vence a las 10 h aunque el préstamo dure más.
 */
const { db, ahora } = require('../config/database');
const env = require('../config/env');
const { ErrorNegocio } = require('../utils/errores');
const log = require('../utils/logger');

const LARGO_CODIGO = 4;

/* ============================================================
   EMISIÓN
   ============================================================ */

/**
 * Genera un código único entre los vigentes de ese casillero.
 * Se reintenta porque el espacio es chico: con muchos préstamos activos en el
 * mismo locker, las colisiones dejan de ser raras.
 */
function generar(casilleroId) {
  const vigentes = db
    .prepare(
      `SELECT codigo FROM prestamos
       WHERE casillero_id = ? AND codigo IS NOT NULL
         AND estado IN ('aprobado', 'activo')`
    )
    .all(casilleroId)
    .map((f) => f.codigo);

  const maximo = 10 ** LARGO_CODIGO;
  if (vigentes.length >= maximo * 0.5)
    throw new ErrorNegocio('Demasiados códigos vigentes en ese casillero', 409);

  for (let intento = 0; intento < 200; intento++) {
    const codigo = String(Math.floor(Math.random() * maximo)).padStart(LARGO_CODIGO, '0');
    if (!vigentes.includes(codigo)) return codigo;
  }
  throw new ErrorNegocio('No se pudo generar un código libre', 500);
}

/** Momento en que vence un código recién emitido. */
const vencimiento = () =>
  new Date(Date.now() + env.reglas.codigoVigenciaHoras * 3600_000).toISOString();

/* ============================================================
   CONTROL DE INTENTOS
   ============================================================ */

function registrarIntento(casilleroId, exito, motivo, origen) {
  db.prepare(
    `INSERT INTO intentos_apertura (casillero_id, exito, motivo, origen, creado_en)
     VALUES (?, ?, ?, ?, ?)`
  ).run(casilleroId, exito ? 1 : 0, motivo, origen, ahora());
}

/**
 * Bloquea el casillero si hubo demasiados fallos seguidos.
 * Solo se cuentan los intentos fallidos posteriores al último acierto: un
 * código correcto limpia el contador, así una persona que se equivocó dos
 * veces y después acertó no arrastra el historial.
 */
function verificarBloqueo(casilleroId) {
  const desde = new Date(Date.now() - env.reglas.bloqueoVentanaMin * 60_000).toISOString();

  const ultimoExito = db
    .prepare(
      `SELECT creado_en FROM intentos_apertura
       WHERE casillero_id = ? AND exito = 1 AND creado_en > ?
       ORDER BY creado_en DESC LIMIT 1`
    )
    .get(casilleroId, desde);

  const fallos = db
    .prepare(
      `SELECT COUNT(*) AS n FROM intentos_apertura
       WHERE casillero_id = ? AND exito = 0 AND creado_en > ?`
    )
    .get(casilleroId, ultimoExito ? ultimoExito.creado_en : desde).n;

  if (fallos >= env.reglas.intentosMaximos)
    throw new ErrorNegocio(
      `Demasiados intentos fallidos. Probá de nuevo en unos minutos o acercate a Alumnado.`,
      429
    );
}

/* ============================================================
   VALIDACIÓN Y USO
   ============================================================ */

/**
 * Busca el préstamo al que corresponde un código en un casillero puntual.
 * Devuelve null si no hay ninguno: el motivo exacto (no existe, vencido,
 * agotado) se resuelve afuera para no filtrar información al que adivina.
 */
function buscarPrestamo(casilleroCodigo, codigo) {
  return db
    .prepare(
      `SELECT p.*, c.codigo AS casillero_codigo, c.estado_puerta,
              i.nombre AS item_nombre, i.unidad,
              u.legajo, u.nombre AS usuario_nombre
       FROM prestamos p
       JOIN casilleros c ON c.id = p.casillero_id
       JOIN items i      ON i.id = p.item_id
       JOIN usuarios u   ON u.id = p.usuario_id
       WHERE c.codigo = ? AND p.codigo = ?
         AND p.estado IN ('aprobado', 'activo')`
    )
    .get(String(casilleroCodigo).trim().toUpperCase(), String(codigo).trim());
}

/**
 * Valida un código sin consumirlo ni abrir nada.
 * Lanza ErrorNegocio con el motivo si no sirve.
 * @returns el préstamo crudo si el código es válido
 */
function validar(casilleroCodigo, codigo, origen) {
  const casillero = db
    .prepare(`SELECT id, codigo, estado_puerta, estado_operativo FROM casilleros WHERE codigo = ?`)
    .get(String(casilleroCodigo).trim().toUpperCase());

  if (!casillero) throw new ErrorNegocio('Ese casillero no existe', 404);

  verificarBloqueo(casillero.id);

  if (!/^\d{4}$/.test(String(codigo || '').trim())) {
    registrarIntento(casillero.id, false, 'formato invalido', origen);
    throw new ErrorNegocio('El código tiene que ser de 4 dígitos', 400);
  }

  const prestamo = buscarPrestamo(casilleroCodigo, codigo);

  // Mensaje genérico a propósito: no le decimos al que adivina si el código
  // existe pero venció, o si directamente no existe.
  if (!prestamo) {
    registrarIntento(casillero.id, false, 'codigo inexistente', origen);
    throw new ErrorNegocio('Código incorrecto o vencido', 403);
  }

  if (prestamo.codigo_usos >= prestamo.codigo_max_usos) {
    registrarIntento(casillero.id, false, 'codigo agotado', origen);
    throw new ErrorNegocio('Ese código ya se usó las dos veces. Acercate a Alumnado.', 403);
  }

  if (prestamo.codigo_expira && Date.parse(prestamo.codigo_expira) < Date.now()) {
    registrarIntento(casillero.id, false, 'codigo vencido', origen);
    throw new ErrorNegocio('El código venció. Acercate a Alumnado para que te den uno nuevo.', 403);
  }

  if (casillero.estado_operativo === 'error') {
    registrarIntento(casillero.id, false, 'casillero fuera de servicio', origen);
    throw new ErrorNegocio('El casillero está fuera de servicio. Avisale a Alumnado.', 409);
  }

  // Si ya está abierta, abrir de nuevo no aporta nada y gastaría un uso.
  if (casillero.estado_puerta === 'abierta') {
    registrarIntento(casillero.id, false, 'puerta ya abierta', origen);
    throw new ErrorNegocio('La puerta ya está abierta.', 409);
  }

  registrarIntento(casillero.id, true, null, origen);
  return prestamo;
}

/** Marca un uso del código. Devuelve cuántos usos quedan. */
function consumirUso(prestamoId) {
  db.prepare(
    `UPDATE prestamos SET codigo_usos = codigo_usos + 1, codigo_ultimo_uso = ? WHERE id = ?`
  ).run(ahora(), prestamoId);

  const fila = db
    .prepare(`SELECT codigo_usos, codigo_max_usos FROM prestamos WHERE id = ?`)
    .get(prestamoId);
  return fila.codigo_max_usos - fila.codigo_usos;
}

/**
 * Watchdog: caduca los préstamos aprobados cuyo código venció sin usarse.
 * El material nunca salió del casillero, así que se libera la reserva.
 */
function caducarCodigosSinUsar() {
  const vencidos = db
    .prepare(
      `SELECT id FROM prestamos
       WHERE estado = 'aprobado' AND codigo_usos = 0
         AND codigo_expira IS NOT NULL AND codigo_expira < ?`
    )
    .all(ahora());

  if (vencidos.length) log.aviso(`${vencidos.length} codigo(s) vencidos sin usar`);
  return vencidos.map((f) => f.id);
}

module.exports = {
  LARGO_CODIGO, generar, vencimiento, validar, consumirUso,
  registrarIntento, verificarBloqueo, caducarCodigosSinUsar,
};
