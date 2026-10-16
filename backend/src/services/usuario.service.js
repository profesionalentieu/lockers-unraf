'use strict';
/**
 * Padron: alumnos, docentes y la cuenta de Alumnado, en la misma tabla.
 *
 * - El PIN se guarda hasheado con bcrypt (pin_hash). Ni Alumnado puede
 *   verlo: si alguien lo olvida, se le asigna uno nuevo.
 * - Baja logica: un usuario con historial nunca se borra, se desactiva.
 * - La sancion (sancionado = 1) no impide entrar ni devolver: impide crear
 *   reservas nuevas y retirar, hasta que Alumnado rehabilite el legajo.
 */
const bcrypt = require('bcryptjs');
const { db } = require('../config/database');
const reloj = require('../utils/reloj');
const hub = require('../realtime/hub');
const { ErrorNegocio } = require('../utils/errores');
const eventos = require('./evento.service');

const ROLES = ['alumno', 'docente'];
const ESTADOS_VIGENTES = ['PENDIENTE_APROBACION', 'RESERVADO', 'EN_USO', 'EN_MORA'];

const hashear = (pin) => bcrypt.hashSync(String(pin), 10);

const mapear = (f) =>
  f && {
    legajo: f.legajo,
    nombre: f.nombre,
    rol: f.rol,
    sancionado: Boolean(f.sancionado),
    motivoSancion: f.motivo_sancion || null,
    sancionadoEn: f.sancionado_en || null,
    activo: Boolean(f.activo),
  };

const filaActiva = (legajo) =>
  db.prepare(`SELECT * FROM usuarios WHERE legajo = ? AND activo = 1`).get(String(legajo ?? '').trim());

const buscar = (legajo) => mapear(filaActiva(legajo));

/** Alumno o docente con su PIN. null si no coincide (mensaje generico afuera). */
function autenticar(legajo, pin) {
  const fila = filaActiva(legajo);
  if (!fila || fila.rol === 'admin') return null;
  return bcrypt.compareSync(String(pin ?? '').trim(), fila.pin_hash) ? mapear(fila) : null;
}

/** Mesa de Alumnado: usuario 'alumnado' + clave. */
function autenticarAdmin(usuario, clave) {
  const fila = filaActiva(usuario);
  if (!fila || fila.rol !== 'admin') return null;
  return bcrypt.compareSync(String(clave ?? ''), fila.pin_hash) ? mapear(fila) : null;
}

function normalizar({ legajo, nombre, pin, rol }, { exigirPin = true } = {}) {
  const limpio = {
    legajo: String(legajo ?? '').trim(),
    nombre: String(nombre ?? '').trim(),
    pin: pin == null ? '' : String(pin).trim(),
    rol: String(rol ?? 'alumno').trim().toLowerCase(),
  };
  if (!/^\d{3,10}$/.test(limpio.legajo))
    throw new ErrorNegocio('El legajo tiene que ser un número de 3 a 10 dígitos', 400);
  if (limpio.nombre.length < 3) throw new ErrorNegocio('Cargá el nombre completo', 400);
  if ((exigirPin || limpio.pin) && !/^\d{4,6}$/.test(limpio.pin))
    throw new ErrorNegocio('El PIN tiene que ser de 4 a 6 dígitos', 400);
  if (!ROLES.includes(limpio.rol))
    throw new ErrorNegocio(`El rol tiene que ser ${ROLES.join(' o ')}`, 400);
  return limpio;
}

/** Padron con el prestamo vigente de cada persona. */
function listar(texto = '') {
  const patron = `%${String(texto).trim()}%`;
  return db
    .prepare(
      `SELECT u.*,
              (SELECT p.id FROM prestamos p
                WHERE p.legajo_usuario = u.legajo
                  AND p.estado IN (${ESTADOS_VIGENTES.map(() => '?').join(',')})
                ORDER BY p.inicio_ts LIMIT 1) AS prestamo_vigente,
              (SELECT COUNT(*) FROM prestamos p WHERE p.legajo_usuario = u.legajo) AS prestamos_totales
       FROM usuarios u
       WHERE u.rol <> 'admin' AND (u.legajo LIKE ? OR u.nombre LIKE ?)
       ORDER BY u.activo DESC, u.sancionado DESC, u.legajo`
    )
    .all(...ESTADOS_VIGENTES, patron, patron)
    .map((f) => ({ ...mapear(f), prestamoVigente: f.prestamo_vigente, prestamosTotales: f.prestamos_totales }));
}

/** Alta individual. Un legajo dado de baja que vuelve se reactiva. */
function crear(datos) {
  const u = normalizar(datos);
  const existe = db.prepare(`SELECT legajo, activo, rol FROM usuarios WHERE legajo = ?`).get(u.legajo);

  if (existe) {
    if (existe.rol === 'admin') throw new ErrorNegocio('Ese legajo está reservado', 409);
    if (existe.activo) throw new ErrorNegocio(`El legajo ${u.legajo} ya está registrado`, 409);
    db.prepare(`UPDATE usuarios SET nombre = ?, pin_hash = ?, rol = ?, activo = 1 WHERE legajo = ?`)
      .run(u.nombre, hashear(u.pin), u.rol, u.legajo);
    return { ...buscar(u.legajo), reactivado: true };
  }

  db.prepare(`INSERT INTO usuarios (legajo, nombre, rol, pin_hash, sancionado, activo) VALUES (?, ?, ?, ?, 0, 1)`)
    .run(u.legajo, u.nombre, u.rol, hashear(u.pin));
  return { ...buscar(u.legajo), reactivado: false };
}

/**
 * Alta masiva pegando una linea por persona:
 *   10234, Bertola Juan, 4821, alumno
 */
function importar(texto) {
  const lineas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const resultado = { creados: 0, reactivados: 0, errores: [] };
  for (const [i, linea] of lineas.entries()) {
    const [legajo, nombre, pin, rol] = linea.split(/[,;\t]/).map((p) => p.trim());
    try {
      const u = crear({ legajo, nombre, pin, rol: rol || 'alumno' });
      u.reactivado ? resultado.reactivados++ : resultado.creados++;
    } catch (e) {
      resultado.errores.push(`Línea ${i + 1}: ${e.message}`);
    }
  }
  return resultado;
}

/** Edita nombre y rol; el PIN solo si viene uno nuevo. */
function actualizar(legajo, { nombre, pin, rol }) {
  const actual = db.prepare(`SELECT * FROM usuarios WHERE legajo = ? AND rol <> 'admin'`).get(legajo);
  if (!actual) throw new ErrorNegocio('La persona no existe', 404);

  const u = normalizar(
    { legajo, nombre: nombre ?? actual.nombre, pin: pin ?? null, rol: rol ?? actual.rol },
    { exigirPin: false }
  );
  db.prepare(`UPDATE usuarios SET nombre = ?, rol = ?, pin_hash = ? WHERE legajo = ?`)
    .run(u.nombre, u.rol, u.pin ? hashear(u.pin) : actual.pin_hash, legajo);
  return buscar(legajo);
}

/** Baja logica. Bloqueada si la persona tiene una reserva o material afuera. */
function desactivar(legajo) {
  const vigente = db
    .prepare(`SELECT id FROM prestamos WHERE legajo_usuario = ? AND estado IN
              ('PENDIENTE_APROBACION','RESERVADO','EN_USO','EN_MORA','PENDIENTE_AUDITORIA')`)
    .get(legajo);
  if (vigente) throw new ErrorNegocio('Tiene una reserva o material sin cerrar: resolvelo primero', 409);
  const info = db.prepare(`UPDATE usuarios SET activo = 0 WHERE legajo = ? AND rol <> 'admin'`).run(legajo);
  if (!info.changes) throw new ErrorNegocio('La persona no existe', 404);
  return { legajo, activo: false };
}

/* ---------- Sanciones ---------- */

function sancionar(legajo, motivo, { actor = 'sistema', lockerId = null, prestamoId = null } = {}) {
  const actual = db.prepare(`SELECT * FROM usuarios WHERE legajo = ? AND rol <> 'admin'`).get(legajo);
  if (!actual) throw new ErrorNegocio('La persona no existe', 404);

  // Si ya estaba sancionado se conserva el primer motivo y se suma el nuevo.
  const texto = actual.sancionado && actual.motivo_sancion && !actual.motivo_sancion.includes(motivo)
    ? `${actual.motivo_sancion} | ${motivo}`
    : motivo;

  db.prepare(`UPDATE usuarios SET sancionado = 1, motivo_sancion = ?, sancionado_en = COALESCE(sancionado_en, ?)
              WHERE legajo = ?`).run(texto, reloj.ahora(), legajo);

  eventos.registrar(eventos.TIPOS.SANCION, { lockerId, prestamoId, actor, detalle: `${legajo}: ${motivo}` });
  const usuario = buscar(legajo);
  hub.emitirA(legajo, 'usuario.actualizado', usuario);
  hub.emitir('usuario.actualizado', usuario, ['admin']);
  return usuario;
}

function rehabilitar(legajo, { actor }) {
  const info = db
    .prepare(`UPDATE usuarios SET sancionado = 0, motivo_sancion = NULL, sancionado_en = NULL
              WHERE legajo = ? AND rol <> 'admin'`)
    .run(legajo);
  if (!info.changes) throw new ErrorNegocio('La persona no existe', 404);
  eventos.registrar(eventos.TIPOS.REHABILITACION, { actor, detalle: legajo });
  const usuario = buscar(legajo);
  hub.emitirA(legajo, 'usuario.actualizado', usuario);
  hub.emitir('usuario.actualizado', usuario, ['admin']);
  return usuario;
}

module.exports = {
  ROLES, ESTADOS_VIGENTES, hashear,
  buscar, autenticar, autenticarAdmin, listar, crear, importar, actualizar, desactivar,
  sancionar, rehabilitar,
};
