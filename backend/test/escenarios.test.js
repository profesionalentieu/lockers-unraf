'use strict';
/**
 * Escenarios del ciclo de vida completo, contra los servicios reales y una
 * base SQLite temporal. El reloj se mueve a mano: asi se prueba el no-show,
 * la mora o el buffer de 30 minutos sin esperar de verdad.
 *
 *   npm test
 *
 * El "hardware" se simula llamando a los mismos servicios que usa el
 * gateway: confirmar el comando (ACK) y reportar el microswitch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panol-')), 'test.db');
process.env.DB_PATH = RUTA;
process.env.WATCHDOG_INTERVALO_MS = '999999';

// Silencia el logger durante los tests
console.log = () => {};

require('../src/db/seed');
const { db } = require('../src/config/database');
const reloj = require('../src/utils/reloj');
const prestamos = require('../src/services/prestamo.service');
const operaciones = require('../src/services/operacion.service');
const telemetria = require('../src/services/telemetria.service');
const comandos = require('../src/services/comando.service');
const lockers = require('../src/services/locker.service');
const usuarios = require('../src/services/usuario.service');
const watchdog = require('../src/services/watchdog.service');

// Lunes 19/10/2026: las franjas de la spec (15:00 a 18:00) caen dentro del horario.
const FECHA = '2026-10-19';
const BIT = { 'A-01': 0, 'A-02': 1, 'A-03': 2, 'A-04': 3 };

const en = (hora, fecha = FECHA) => reloj.fijar(reloj.instante(fecha, hora));
const avanzarSeg = (s) => reloj.desplazar(s * 1000);
const avanzarMin = (m) => reloj.desplazar(m * 60000);

function limpiar() {
  db.exec(`DELETE FROM comandos; DELETE FROM logs_auditoria; DELETE FROM eventos; DELETE FROM prestamos;`);
  db.exec(`UPDATE lockers SET estado_puerta = 'CERRADO', abierta_desde = NULL, alerta_puerta_enviada = 0,
           estado_operativo = 'ok', detalle_error = NULL, op_tipo = NULL, op_prestamo_id = NULL, op_legajo = NULL,
           op_iniciada_en = NULL, op_pulso_hasta = NULL, op_comando_id = NULL, op_abrio = 0, op_en_termino = NULL`);
  const inicial = {
    'A-01': ['Notebook Lenovo 14"', 25], 'A-02': ['Zapatilla 5 tomas 5 m', 10],
    'A-03': ['Fibrón para pizarra', 50], 'A-04': ['Kit Arduino UNO', 12],
  };
  const stmt = db.prepare(`UPDATE lockers SET descripcion_item = ?, capacidad_maxima = ?, stock_actual_fisico = ? WHERE id = ?`);
  for (const [id, [descripcion, total]] of Object.entries(inicial)) stmt.run(descripcion, total, total, id);
  db.exec(`UPDATE usuarios SET sancionado = 0, motivo_sancion = NULL, sancionado_en = NULL`);
}

/** Reserva directa. */
const reservar = (legajo, lockerId, cantidad, horaInicio, duracionHoras = 1, fecha = FECHA) =>
  prestamos.solicitar({ legajo, lockerId, cantidad, fecha, horaInicio, duracionHoras }).prestamo;

const codigoDe = (id) => db.prepare(`SELECT codigo_operacion FROM prestamos WHERE id = ?`).get(id).codigo_operacion;
const estadoDe = (id) => prestamos.fila(id).estado;

/** ACK del ultimo comando de un locker, como lo haria el gateway. */
function ack(lockerId) {
  const c = db.prepare(`SELECT id FROM comandos WHERE locker_id = ? ORDER BY id DESC LIMIT 1`).get(lockerId);
  return comandos.confirmar(c.id, { ok: true });
}
const puerta = (lockerId, abierta) =>
  telemetria.registrarPuerta({ nodo: 'NODO-A', bit: BIT[lockerId], puertaAbierta: abierta });

/** Circuito fisico completo: codigo -> ACK -> abrir -> cerrar. */
function abrirYCerrar(lockerId, codigo) {
  const op = operaciones.accesoConCodigo(lockerId, codigo);
  ack(lockerId);
  avanzarSeg(3);
  puerta(lockerId, true);
  avanzarSeg(10);
  puerta(lockerId, false);
  return op;
}

const logs = (prestamoId) => db.prepare(`SELECT evento FROM logs_auditoria WHERE prestamo_id = ? ORDER BY id`).all(prestamoId).map((f) => f.evento);

test.beforeEach(() => limpiar());
test.after(() => reloj.reiniciar());

/* ============================================================ */

test('Docente con <= 50% pasa directo a RESERVADO y recibe codigo; el alumno queda pendiente', () => {
  en('10:00');
  const docente = reservar('20011', 'A-01', 5, '15:00', 3);
  assert.equal(docente.estado, 'RESERVADO');
  assert.match(docente.codigoOperacion, /^\d{6}$/);
  assert.equal(docente.horaLimite, '18:00');
  assert.equal(docente.horaFinBuffer, '18:30');

  const alumno = reservar('10234', 'A-02', 1, '11:00', 1);
  assert.equal(alumno.estado, 'PENDIENTE_APROBACION');
  assert.equal(alumno.codigoOperacion, null, 'el codigo no se muestra hasta aprobar');

  const aprobado = prestamos.aprobar(alumno.id, { actor: 'alumnado' }).prestamo;
  assert.equal(aprobado.estado, 'RESERVADO');
  assert.match(aprobado.codigoOperacion, /^\d{6}$/);
});

test('Docente que pide mas del 50% de la capacidad necesita aprobacion', () => {
  en('10:00');
  const p = reservar('20011', 'A-01', 13, '15:00', 2);
  assert.equal(p.estado, 'PENDIENTE_APROBACION');
  assert.equal(p.requiereAprobacion, true);
});

test('Stock parcial (spec 2.2): 5 de 25 bloqueadas de 15:00 a 18:30, quedan 20 a las 16:00', () => {
  en('10:00');
  reservar('20011', 'A-01', 5, '15:00', 3);
  const desde = reloj.instante(FECHA, '16:00');
  assert.equal(lockers.disponibleEnFranja('A-01', desde, desde + 90 * 60000), 20);

  const segundo = reservar('20012', 'A-01', 3, '16:00', 1);
  assert.equal(segundo.estado, 'RESERVADO');
  // A las 18:30 termina el buffer del primero: vuelven a estar las 22 restantes
  const tarde = reloj.instante(FECHA, '18:30');
  assert.equal(lockers.disponibleEnFranja('A-01', tarde, tarde + 90 * 60000), 25);
});

test('No se puede reservar mas de lo disponible en la franja', () => {
  en('10:00');
  reservar('20011', 'A-02', 8, '15:00', 1);   // 8 > 5 -> pendiente, pero bloquea igual
  assert.throws(() => reservar('20012', 'A-02', 3, '15:30', 1), /quedan 2/);
  // Fuera de la franja (despues del buffer de las 16:30) si hay
  assert.equal(reservar('20012', 'A-02', 3, '16:30', 1).estado, 'RESERVADO');
});

test('Reglas del alumno: 1 unidad, solo hoy, 1 prestamo activo', () => {
  en('10:00');
  assert.throws(() => reservar('10234', 'A-03', 2, '11:00'), /1 unidad/);
  assert.throws(() => reservar('10234', 'A-03', 1, '11:00', 1, reloj.sumarDias(FECHA, 1)), /día en curso/);
  reservar('10234', 'A-03', 1, '11:00');
  assert.throws(() => reservar('10234', 'A-03', 1, '13:00'), /préstamo activo/);
});

test('Reglas del docente: hasta 7 dias, una reserva activa, bloques de 1 a 4 h', () => {
  en('10:00');
  assert.throws(() => reservar('20011', 'A-03', 1, '11:00', 1, reloj.sumarDias(FECHA, 8)), /7 días/);
  assert.throws(() => reservar('20011', 'A-03', 1, '11:00', 5), /1, 2, 3 o 4/);
  const p = reservar('20011', 'A-03', 20, '11:00', 1, reloj.sumarDias(FECHA, 7));
  assert.equal(p.estado, 'RESERVADO');
  assert.throws(() => reservar('20011', 'A-02', 1, '12:00'), /reserva activa/);
  // Al cancelar la vigente se habilita otra
  prestamos.cancelar(p.id, { legajo: '20011', actor: '20011' });
  assert.equal(reservar('20011', 'A-02', 1, '12:00').estado, 'RESERVADO');
});

test('Retiro en termino: codigo -> pulso 15 s -> switch ABIERTO -> CERRADO -> EN_USO', () => {
  en('10:00');
  const p = reservar('20011', 'A-01', 5, '15:00', 3);
  en('14:50');
  assert.throws(() => operaciones.accesoConCodigo('A-01', codigoDe(p.id)), /se habilita a las 15:00/);

  en('15:05');
  assert.throws(() => operaciones.accesoConCodigo('A-02', codigoDe(p.id)), /locker A-01/);
  const op = operaciones.accesoConCodigo('A-01', codigoDe(p.id));
  assert.equal(op.tipo, 'RETIRO');
  assert.equal(op.fase, 'enviando');

  const comando = db.prepare(`SELECT * FROM comandos WHERE prestamo_id = ?`).get(p.id);
  assert.equal(comando.duracion_ms, 15000, 'el pulso es de 15 s');
  assert.equal(comandos.paraGateway(comandos.obtener(comando.id)).ms, 15000);

  ack('A-01');
  assert.equal(operaciones.estado('A-01', p.id, 'RETIRO').fase, 'pulso');
  avanzarSeg(4);
  puerta('A-01', true);
  assert.equal(operaciones.estado('A-01', p.id, 'RETIRO').fase, 'abierta');
  assert.equal(estadoDe(p.id), 'RESERVADO', 'recien al cerrar pasa a EN_USO');
  avanzarSeg(20);
  puerta('A-01', false);

  assert.equal(estadoDe(p.id), 'EN_USO');
  assert.ok(prestamos.fila(p.id).timestamp_retiro);
  assert.equal(operaciones.estado('A-01', p.id, 'RETIRO').fase, 'finalizada');
  assert.deepEqual(logs(p.id), ['PULSO_APERTURA_RETIRO', 'PUERTA_ABIERTA', 'PUERTA_CERRADA']);
  assert.equal(lockers.fila('A-01').op_tipo, null, 'el locker queda libre');
});

test('No-show: a los 15 min sin abrir se cancela, libera stock e invalida el codigo', () => {
  en('10:00');
  const p = reservar('20011', 'A-01', 20, '15:00', 1);   // 20 > 12.5 -> pendiente
  prestamos.aprobar(p.id, { actor: 'alumnado' });
  const codigo = codigoDe(p.id);
  const desde = reloj.instante(FECHA, '15:00');
  assert.equal(lockers.disponibleEnFranja('A-01', desde, desde + 3600000), 5);

  en('15:14');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'RESERVADO');
  en('15:16');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'CANCELADO_NO_SHOW');
  assert.equal(lockers.disponibleEnFranja('A-01', desde, desde + 3600000), 25);
  assert.throws(() => operaciones.accesoConCodigo('A-01', codigo), /inválido o vencido/);
  // El docente queda habilitado para otra reserva
  assert.equal(reservar('20011', 'A-02', 1, '16:00').estado, 'RESERVADO');
});

test('Puerta trabada: sin apertura en 15 s se habilita Reintentar sin penalizar la reserva', () => {
  en('10:00');
  const p = reservar('20012', 'A-02', 2, '15:00', 1);
  en('15:10');
  operaciones.accesoConCodigo('A-02', codigoDe(p.id));
  ack('A-02');
  // Mientras el pulso corre, "reintentar" no manda otra orden
  const mientras = operaciones.reintentar(p.id, 'RETIRO');
  assert.equal(mientras.fase, 'pulso');
  assert.equal(mientras.nueva, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM comandos WHERE prestamo_id = ?`).get(p.id).n, 1);
  avanzarSeg(16);
  const sinApertura = operaciones.estado('A-02', p.id, 'RETIRO');
  assert.equal(sinApertura.fase, 'sin_apertura');
  assert.equal(sinApertura.puedeReintentar, true);

  // Ya paso la tolerancia (15:16) pero la persona VINO: no es no-show
  en('15:17');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'RESERVADO');

  const reintento = operaciones.reintentar(p.id, 'RETIRO');
  assert.equal(reintento.nueva, false);
  ack('A-02');
  puerta('A-02', true);
  puerta('A-02', false);
  assert.equal(estadoDe(p.id), 'EN_USO');
  assert.deepEqual(logs(p.id), ['PULSO_APERTURA_RETIRO', 'REINTENTO_APERTURA', 'PUERTA_ABIERTA', 'PUERTA_CERRADA']);
});

test('Un locker atiende una operacion por vez: el segundo espera a que se cierre la puerta', () => {
  en('10:00');
  const a = reservar('20011', 'A-03', 5, '15:00', 1);
  const b = reservar('20012', 'A-03', 5, '15:00', 1);
  en('15:02');
  operaciones.accesoConCodigo('A-03', codigoDe(a.id));
  ack('A-03');
  puerta('A-03', true);
  assert.throws(() => operaciones.accesoConCodigo('A-03', codigoDe(b.id)), /otra persona/);
  puerta('A-03', false);
  operaciones.accesoConCodigo('A-03', codigoDe(b.id));
  ack('A-03');
  puerta('A-03', true);
  puerta('A-03', false);
  assert.equal(estadoDe(a.id), 'EN_USO');
  assert.equal(estadoDe(b.id), 'EN_USO');
});

test('Alerta de puerta mal cerrada a los 45 s', () => {
  en('10:00');
  const p = reservar('20011', 'A-04', 2, '15:00', 1);
  en('15:01');
  operaciones.accesoConCodigo('A-04', codigoDe(p.id));
  ack('A-04');
  puerta('A-04', true);
  avanzarSeg(44);
  watchdog.ciclo();
  assert.equal(lockers.fila('A-04').alerta_puerta_enviada, 0);
  avanzarSeg(2);
  watchdog.ciclo();
  assert.equal(lockers.fila('A-04').alerta_puerta_enviada, 1);
  assert.ok(logs(p.id).includes('ALERTA_PUERTA_ABIERTA'));
  assert.equal(operaciones.estado('A-04', p.id, 'RETIRO').alertaPuertaAbierta, true);
  puerta('A-04', false);
  assert.equal(estadoDe(p.id), 'EN_USO');
});

test('Reporte de faltante: senala al ultimo legajo que cerro el locker', () => {
  en('10:00');
  const primero = reservar('20011', 'A-03', 10, '11:00', 1);
  en('11:01');
  abrirYCerrar('A-03', codigoDe(primero.id));

  en('11:30');
  const segundo = reservar('20012', 'A-03', 10, '12:00', 1);
  en('12:02');
  operaciones.accesoConCodigo('A-03', codigoDe(segundo.id));
  ack('A-03');
  puerta('A-03', true);
  const reporte = operaciones.reportarIncidencia(segundo.id, { legajo: '20012', detalle: 'Hay 8 fibrones, faltan 2' });
  assert.equal(reporte.presuntoResponsable.legajo, '20011');

  const fila = db.prepare(`SELECT * FROM logs_auditoria WHERE id = ?`).get(reporte.incidenciaId);
  assert.equal(fila.evento, 'REPORTE_FALTANTE_O_DANO');
  assert.equal(fila.ultimo_responsable_previo, '20011');
  assert.equal(require('../src/services/auditoria.service').incidenciasPendientes().length, 1);
});

test('Devolucion estandar (Camino A): docente <= 50% en termino -> BUFFER_30_MIN -> FINALIZADO', () => {
  en('10:00');
  const p = reservar('20011', 'A-01', 5, '15:00', 3);
  en('15:02');
  abrirYCerrar('A-01', codigoDe(p.id));
  assert.equal(estadoDe(p.id), 'EN_USO');

  en('16:00');
  const op = operaciones.devolucionDesdeSesion(p.id, '20011');
  assert.equal(op.tipo, 'DEVOLUCION');
  ack('A-01');
  puerta('A-01', true);
  puerta('A-01', false);
  assert.equal(estadoDe(p.id), 'BUFFER_30_MIN');
  assert.equal(prestamos.fila(p.id).camino_devolucion, 'A');

  // Durante el buffer las 5 siguen bloqueadas; el docente ya puede reservar otra
  const ahora = reloj.ahoraMs();
  assert.equal(lockers.disponibleEnFranja('A-01', ahora, ahora + 60000), 20);
  assert.equal(reservar('20011', 'A-02', 1, '17:00').estado, 'RESERVADO');

  avanzarMin(31);
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'FINALIZADO');
  const luego = reloj.ahoraMs();
  assert.equal(lockers.disponibleEnFranja('A-01', luego, luego + 60000), 25);
  assert.ok(logs(p.id).includes('PULSO_APERTURA_DEVOLUCION'));
});

test('Devolucion critica (Camino B): alumno -> PENDIENTE_AUDITORIA hasta "Confirmar Stock OK"', () => {
  en('10:00');
  const p = reservar('10235', 'A-04', 1, '10:30', 1);
  prestamos.aprobar(p.id, { actor: 'alumnado' });
  en('10:31');
  abrirYCerrar('A-04', codigoDe(p.id));
  en('11:00');
  abrirYCerrar('A-04', codigoDe(p.id));
  assert.equal(estadoDe(p.id), 'PENDIENTE_AUDITORIA');

  // Muy despues de la franja, la unidad sigue sin volver al stock
  avanzarMin(240);
  watchdog.ciclo();
  const t = reloj.ahoraMs();
  assert.equal(lockers.disponibleEnFranja('A-04', t, t + 60000), 11);

  prestamos.confirmarAuditoria(p.id, { actor: 'alumnado' });
  assert.equal(estadoDe(p.id), 'FINALIZADO');
  assert.equal(lockers.disponibleEnFranja('A-04', t, t + 60000), 12);
});

test('Auditoria con diferencia descuenta stock fisico y puede sancionar', () => {
  en('10:00');
  const p = reservar('20011', 'A-02', 8, '10:30', 1);
  prestamos.aprobar(p.id, { actor: 'alumnado' });
  en('10:31');
  abrirYCerrar('A-02', codigoDe(p.id));
  en('11:00');
  abrirYCerrar('A-02', codigoDe(p.id));
  assert.equal(estadoDe(p.id), 'PENDIENTE_AUDITORIA', '> 50% va siempre a auditoria');
  prestamos.confirmarAuditoria(p.id, { actor: 'alumnado', unidadesRecibidas: 7, sancionar: true });
  assert.equal(lockers.fila('A-02').stock_actual_fisico, 9);
  assert.equal(usuarios.buscar('20011').sancionado, true);
});

test('Mora: al pasar la hora limite -> EN_MORA + sancion; al devolver -> auditoria', () => {
  en('10:00');
  const p = reservar('20011', 'A-01', 5, '15:00', 1);
  en('15:01');
  abrirYCerrar('A-01', codigoDe(p.id));
  en('16:01');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'EN_MORA');
  assert.equal(usuarios.buscar('20011').sancionado, true);
  assert.match(usuarios.buscar('20011').motivoSancion, /Mora/);
  assert.equal(prestamos.obtener(p.id).minutosDemora, 1);

  // Sancionado: no puede crear reservas nuevas
  assert.throws(() => reservar('20011', 'A-02', 1, '17:00'), /sancionado/);

  // Las unidades en mora siguen bloqueadas aunque haya pasado su franja
  const t = reloj.instante(FECHA, '19:00');
  assert.equal(lockers.disponibleEnFranja('A-01', t, t + 3600000), 20);

  en('16:40');
  abrirYCerrar('A-01', codigoDe(p.id));
  assert.equal(estadoDe(p.id), 'PENDIENTE_AUDITORIA');
  assert.equal(prestamos.fila(p.id).devolucion_en_termino, 0);

  usuarios.rehabilitar('20011', { actor: 'alumnado' });
  assert.equal(usuarios.buscar('20011').sancionado, false);
});

test('Devolucion iniciada antes de la hora limite no cae en mora aunque la puerta cierre despues', () => {
  en('10:00');
  const p = reservar('20012', 'A-03', 4, '15:00', 1);
  en('15:01');
  abrirYCerrar('A-03', codigoDe(p.id));
  en('15:59');
  operaciones.accesoConCodigo('A-03', codigoDe(p.id));
  ack('A-03');
  puerta('A-03', true);
  en('16:02');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'EN_USO');
  puerta('A-03', false);
  assert.equal(estadoDe(p.id), 'BUFFER_30_MIN');
  assert.equal(usuarios.buscar('20012').sancionado, false);
});

test('Mitigacion: el turno siguiente se reasigna a otro locker con el mismo material', () => {
  // A-04 pasa a guardar notebooks: es el "otro locker" de la spec 4.3.1
  db.exec(`UPDATE lockers SET descripcion_item = 'Notebook Lenovo 14"', capacidad_maxima = 25, stock_actual_fisico = 25 WHERE id = 'A-04'`);
  en('10:00');
  const moroso = reservar('20011', 'A-01', 12, '15:00', 3);       // 15:00-18:00 (+buffer 18:30)
  const siguiente = reservar('20012', 'A-01', 12, '18:30', 1);    // turno siguiente
  const codigoViejo = codigoDe(siguiente.id);
  en('15:01');
  abrirYCerrar('A-01', codigoDe(moroso.id));
  db.exec(`UPDATE lockers SET stock_actual_fisico = 20 WHERE id = 'A-01'`);  // 8 quedaron afuera por un faltante

  en('18:01');
  watchdog.ciclo();
  assert.equal(estadoDe(moroso.id), 'EN_MORA');

  en('18:14');
  watchdog.ciclo();
  assert.equal(prestamos.fila(siguiente.id).locker_id, 'A-01', 'todavia no es el momento');
  en('18:16');
  watchdog.ciclo();
  const movido = prestamos.fila(siguiente.id);
  assert.equal(movido.locker_id, 'A-04');
  assert.equal(movido.locker_original_id, 'A-01');
  assert.notEqual(movido.codigo_operacion, codigoViejo, 'recibe un codigo nuevo');
  assert.throws(() => operaciones.accesoConCodigo('A-01', codigoViejo), /inválido/);
});

test('Mitigacion sin otro locker: aviso de respaldo en ventanilla y no se cancela por no-show', () => {
  en('10:00');
  const moroso = reservar('20011', 'A-02', 5, '15:00', 1);
  const siguiente = reservar('20012', 'A-02', 5, '16:30', 1);
  en('15:01');
  abrirYCerrar('A-02', codigoDe(moroso.id));
  db.exec(`UPDATE lockers SET stock_actual_fisico = 9 WHERE id = 'A-02'`);
  en('16:01');
  watchdog.ciclo();
  en('16:16');
  watchdog.ciclo();
  assert.equal(prestamos.fila(siguiente.id).requiere_respaldo, 1);
  assert.equal(prestamos.requierenRespaldo().length, 1);
  assert.throws(() => operaciones.accesoConCodigo('A-02', codigoDe(siguiente.id)), /ventanilla/);

  en('16:50');
  watchdog.ciclo();
  assert.equal(estadoDe(siguiente.id), 'RESERVADO', 'no es un no-show: espera la ventanilla');
  prestamos.entregaVentanilla(siguiente.id, { actor: 'alumnado' });
  assert.equal(estadoDe(siguiente.id), 'EN_USO');
});

test('Solicitud que nadie aprueba antes del fin de la tolerancia se rechaza sola', () => {
  en('10:00');
  const p = reservar('10234', 'A-03', 1, '10:30', 1);
  en('10:46');
  watchdog.ciclo();
  assert.equal(estadoDe(p.id), 'RECHAZADO');
  assert.match(prestamos.fila(p.id).motivo_rechazo, /tolerancia/);
});

test('Una orden de apertura vieja no se le entrega al gateway', () => {
  en('10:00');
  const p = reservar('20011', 'A-03', 1, '10:00', 1);
  operaciones.accesoConCodigo('A-03', codigoDe(p.id));
  assert.equal(comandos.pendientes().length, 1);
  avanzarSeg(31);
  assert.equal(comandos.pendientes().length, 0);
  assert.equal(operaciones.estado('A-03', p.id, 'RETIRO').fase, 'sin_apertura');
});

test('Apertura sin operacion autorizada queda registrada sin responsable', () => {
  en('10:00');
  puerta('A-02', true);
  puerta('A-02', false);
  const filas = db.prepare(`SELECT legajo_usuario, evento FROM logs_auditoria WHERE locker_id = 'A-02'`).all();
  assert.deepEqual(filas.map((f) => f.evento), ['PUERTA_ABIERTA', 'PUERTA_CERRADA']);
  assert.ok(filas.every((f) => f.legajo_usuario === 'sistema'));
});
