'use strict';
/**
 * Watchdog del sistema: corre cada 5000 ms (spec, Fase 2 escenario B) y es
 * lo que hace avanzar la maquina de estados con el paso del tiempo.
 *
 *   1. Solicitudes que Alumnado no aprobo antes del fin de la tolerancia -> RECHAZADO
 *   2. Reservas sin retirar a los 15 min                                 -> CANCELADO_NO_SHOW
 *   3. Prestamos que llegaron a la hora limite                           -> EN_MORA + sancion
 *   4. Devoluciones estandar que cumplieron los 30 min                   -> FINALIZADO
 *   5. Turnos que empiezan en 15 min sin stock suficiente                -> reasignar o respaldo
 *   6. Operaciones fisicas: abandono, puerta mal cerrada (45 s), trabada (120 s)
 *   7. Comandos de radio sin ACK                                         -> fallido
 *
 * Cada paso esta aislado: si uno falla, los demas siguen corriendo.
 */
const env = require('../config/env');
const log = require('../utils/logger');
const prestamos = require('./prestamo.service');
const operaciones = require('./operacion.service');
const comandos = require('./comando.service');

const PASOS = [
  ['solicitudes vencidas', () => prestamos.rechazarVencidas()],
  ['no-show', () => prestamos.cancelarNoShow()],
  ['mora', () => prestamos.marcarMora()],
  ['buffer', () => prestamos.liberarBuffers()],
  ['mitigacion', () => prestamos.mitigarTurnos()],
  ['operaciones', () => operaciones.vigilar()],
  ['comandos', () => comandos.caducarVencidos()],
];

/** Una pasada completa. Los tests la llaman directo despues de mover el reloj. */
function ciclo() {
  const resultado = {};
  for (const [nombre, paso] of PASOS) {
    try {
      resultado[nombre] = paso();
    } catch (e) {
      log.error(`Watchdog (${nombre}):`, e.message);
    }
  }
  return resultado;
}

let temporizador = null;

function iniciar() {
  temporizador = setInterval(ciclo, env.reglas.watchdogIntervaloMs);
  temporizador.unref?.();
  log.info(`Watchdog activo cada ${env.reglas.watchdogIntervaloMs} ms`);
}

const detener = () => clearInterval(temporizador);

module.exports = { iniciar, detener, ciclo };
