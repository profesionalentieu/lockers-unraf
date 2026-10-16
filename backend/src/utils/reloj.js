'use strict';
/**
 * Reloj del sistema.
 *
 * Toda la logica de franjas pregunta la hora aca y no a Date.now(), por dos
 * motivos:
 *   1. Las reservas se piensan en hora LOCAL del panol (15:00 hs), pero la
 *      base guarda instantes en UTC. La conversion vive en un solo lugar.
 *   2. Los tests necesitan "adelantar el reloj" para probar el no-show, la
 *      mora o el buffer de 30 minutos sin esperar de verdad.
 */
const env = require('../config/env');

let desplazamientoMs = 0;

/** Minutos de diferencia con UTC: '-03:00' -> -180. */
function offsetMinutos(texto = env.zonaHoraria) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(texto);
  if (!m) return -180;
  const valor = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -valor : valor;
}
const OFFSET_MIN = offsetMinutos();
const OFFSET_MS = OFFSET_MIN * 60000;

const ahoraMs = () => Date.now() + desplazamientoMs;
const ahora = () => new Date(ahoraMs()).toISOString();
const iso = (ms) => new Date(ms).toISOString();

/** Fecha local 'YYYY-MM-DD' de un instante. */
const fechaLocal = (ms = ahoraMs()) => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);

/** Hora local 'HH:MM' de un instante. */
const horaLocal = (ms = ahoraMs()) => new Date(ms + OFFSET_MS).toISOString().slice(11, 16);

/** Minutos desde la medianoche local. */
const minutosDelDia = (ms = ahoraMs()) => {
  const d = new Date(ms + OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** ('2026-10-16', '15:00') -> instante UTC en ms. */
function instante(fecha, hora) {
  const ms = Date.parse(`${fecha}T${hora}:00.000Z`);
  return ms - OFFSET_MS;
}

/** Suma dias a una fecha 'YYYY-MM-DD' (sin tocar la hora). */
function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Diferencia en dias entre dos fechas 'YYYY-MM-DD'. */
const diasEntre = (desde, hasta) =>
  Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 864e5);

/** 'HH:MM' -> minutos. */
const aMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** minutos -> 'HH:MM' */
const aHora = (minutos) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/* ---------- Solo para tests y demostraciones ---------- */
const desplazar = (ms) => { desplazamientoMs += ms; };
const fijar = (ms) => { desplazamientoMs = ms - Date.now(); };
const reiniciar = () => { desplazamientoMs = 0; };

module.exports = {
  OFFSET_MIN,
  ahoraMs, ahora, iso,
  fechaLocal, horaLocal, minutosDelDia, instante, sumarDias, diasEntre, aMinutos, aHora,
  desplazar, fijar, reiniciar,
};
