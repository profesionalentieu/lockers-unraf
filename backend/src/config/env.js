'use strict';
/**
 * Carga y normaliza la configuracion del sistema.
 * Toda la app lee de aca: nunca se usa process.env directo en otro archivo.
 *
 * Los valores por defecto son los de la especificacion tecnica (v3):
 *   - bloques de 1, 2, 3 o 4 horas
 *   - 15 min de tolerancia para retirar
 *   - 30 min de buffer posdevolucion
 *   - pulso de 15 s en el solenoide
 *   - alerta de puerta mal cerrada a los 45 s
 *   - watchdog cada 5000 ms
 */
require('dotenv').config();

const num = (valor, porDefecto) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
};

/** 'HH:MM' -> minutos desde la medianoche. */
const aMinutos = (hhmm, porDefecto) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return porDefecto;
  return Number(m[1]) * 60 + Number(m[2]);
};

module.exports = {
  puerto: num(process.env.PORT, 3000),

  // Ruta de la base. Se puede cambiar para correr los tests sin tocar la real.
  rutaDb: process.env.DB_PATH || null,

  jwt: {
    secreto: process.env.JWT_SECRET || 'dev-secret-no-usar-en-produccion',
    expiraUsuario: process.env.JWT_EXPIRA_USUARIO || process.env.JWT_EXPIRA_ALUMNO || '2h',
    expiraAdmin: process.env.JWT_EXPIRA_ADMIN || '8h',
    // Token corto que recibe la pantalla del locker despues de validar el codigo.
    expiraOperacion: process.env.JWT_EXPIRA_OPERACION || '20m',
  },

  // El gateway se autentica con una API key fija (header x-api-key)
  gatewayApiKey: process.env.GATEWAY_API_KEY || 'gw-lora-unraf-2025',

  // URL publica que va impresa en los QR de las puertas. Si no se define, se
  // arma con el Host de la peticion (sirve en la red de la facultad).
  urlPublica: (process.env.URL_PUBLICA || '').replace(/\/$/, '') || null,

  /**
   * Zona horaria del panol como desplazamiento fijo. Argentina no tiene
   * horario de verano, asi que un offset alcanza y evita depender de la
   * base de datos de zonas del sistema operativo.
   */
  zonaHoraria: process.env.ZONA_HORARIA || '-03:00',

  reglas: {
    // ---- Franjas ----
    duracionesHoras: [1, 2, 3, 4],
    horarioAperturaMin: aMinutos(process.env.HORARIO_APERTURA, 8 * 60),
    horarioCierreMin: aMinutos(process.env.HORARIO_CIERRE, 22 * 60),
    pasoFranjaMin: num(process.env.PASO_FRANJA_MIN, 15),
    toleranciaRetiroMin: num(process.env.TOLERANCIA_RETIRO_MIN, 15),
    bufferPosdevolucionMin: num(process.env.BUFFER_POSDEVOLUCION_MIN, 30),
    docenteDiasAnticipacion: num(process.env.DOCENTE_DIAS_ANTICIPACION, 7),
    // A cuantos minutos del turno siguiente se evalua si hay stock para cubrirlo
    mitigacionAnticipacionMin: num(process.env.MITIGACION_ANTICIPACION_MIN, 15),

    // ---- Hardware ----
    pulsoAperturaSeg: num(process.env.PULSO_APERTURA_SEG, 15),
    alertaPuertaAbiertaSeg: num(process.env.ALERTA_PUERTA_ABIERTA_SEG, 45),
    // Mas alla de esto la puerta se considera trabada y el locker pasa a ERROR
    puertaAbiertaMaxSeg: num(process.env.PUERTA_ABIERTA_MAX_SEG, 120),
    // Una operacion que nunca abrio la puerta se abandona pasado este tiempo
    operacionAbandonoSeg: num(process.env.OPERACION_ABANDONO_SEG, 120),
    comandoTimeoutSeg: num(process.env.COMANDO_TIMEOUT_SEG, 5),
    comandoMaxIntentos: num(process.env.COMANDO_MAX_INTENTOS, 3),
    // Una orden de apertura vieja NO se entrega: abriria una puerta sin nadie adelante
    comandoVigenciaSeg: num(process.env.COMANDO_VIGENCIA_SEG, 30),
    nodoOfflineSeg: num(process.env.NODO_OFFLINE_SEG, 180),

    // ---- Seguridad de la pantalla del locker ----
    accesoIntentosMax: num(process.env.ACCESO_INTENTOS_MAX, 8),
    accesoVentanaSeg: num(process.env.ACCESO_VENTANA_SEG, 300),

    // Cada cuanto corre el watchdog (la especificacion pide 5000 ms)
    watchdogIntervaloMs: num(process.env.WATCHDOG_INTERVALO_MS, 5000),
  },
};
