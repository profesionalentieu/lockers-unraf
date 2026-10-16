'use strict';
/**
 * Alertas en tiempo real para la Mesa de Alumnado (y, cuando corresponde,
 * para la persona involucrada y la pantalla del locker).
 *
 * Una alerta es un aviso empujado por WebSocket, no un registro: lo que
 * queda pendiente de resolver se reconstruye siempre desde la base (mora,
 * auditorias, incidencias, respaldo), asi que un panel que se conecta tarde
 * ve exactamente lo mismo que uno que estaba abierto.
 */
const hub = require('../realtime/hub');

const NIVELES = { CRITICA: 'critica', ADVERTENCIA: 'advertencia', INFO: 'info' };

/**
 * @param {object} alerta  { tipo, nivel, mensaje, lockerId?, prestamoId?, legajo? }
 * @param {object} destino { usuario?: legajo, locker?: lockerId }
 */
function alertar(alerta, destino = {}) {
  const datos = { nivel: NIVELES.INFO, ...alerta, ts: new Date().toISOString() };
  hub.emitir('alerta', datos, ['admin']);
  if (destino.usuario) hub.emitirA(destino.usuario, 'alerta', datos);
  if (destino.locker) hub.emitirALocker(destino.locker, 'alerta', datos);
}

module.exports = { NIVELES, alertar };
