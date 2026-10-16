'use strict';
const env = require('../config/env');
const { firmarToken } = require('../middleware/auth');
const usuarios = require('../services/usuario.service');
const prestamos = require('../services/prestamo.service');

/** POST /api/auth/admin/login  { usuario, password } */
function loginAdmin(req, res) {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ error: 'Ingresá usuario y contraseña' });

  // Mensaje generico a proposito: no revelamos si el usuario existe.
  const admin = usuarios.autenticarAdmin(String(usuario).trim(), password);
  if (!admin) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  res.json({
    token: firmarToken({ rol: 'admin', usuario: admin.legajo, nombre: admin.nombre }, env.jwt.expiraAdmin),
    usuario: { usuario: admin.legajo, nombre: admin.nombre },
  });
}

/**
 * POST /api/auth/usuario/login  { legajo, pin }
 * Alumnos y docentes. Se puede entrar sancionado (hay que poder devolver),
 * pero la respuesta lo dice y las reservas nuevas quedan bloqueadas.
 */
function loginUsuario(req, res) {
  const { legajo, pin } = req.body || {};
  if (!legajo || !pin) return res.status(400).json({ error: 'Ingresá tu legajo y tu PIN' });

  const persona = usuarios.autenticar(String(legajo).trim(), pin);
  if (!persona) return res.status(401).json({ error: 'Legajo o PIN incorrectos' });

  res.json({
    token: firmarToken(
      { rol: 'usuario', rolUsuario: persona.rol, legajo: persona.legajo, nombre: persona.nombre },
      env.jwt.expiraUsuario
    ),
    usuario: persona,
    reglas: prestamos.reglasPara(persona.rol),
    vigente: prestamos.vigenteDe(persona.legajo),
  });
}

module.exports = { loginAdmin, loginUsuario };
