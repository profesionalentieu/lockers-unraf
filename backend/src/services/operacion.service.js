'use strict';
/**
 * Operaciones fisicas frente al locker (spec, Fases 2 y 3).
 *
 * Una OPERACION es lo que pasa desde que alguien valida su codigo hasta que
 * la puerta vuelve a cerrarse:
 *
 *   validar codigo ─> pulso de 15 s ─┬─> switch ABIERTO ─> switch CERRADO ─> fin
 *                                    │      (retira / deposita)   │
 *                                    │                            ├─ RETIRO:     RESERVADO -> EN_USO
 *                                    │                            └─ DEVOLUCION: -> BUFFER_30_MIN o
 *                                    │                                             PENDIENTE_AUDITORIA
 *                                    └─> 15 s sin apertura ─> "Reintentar Apertura" (sin penalizar)
 *
 * Varios prestamos comparten un locker (stock parcial), pero la puerta y el
 * microswitch son uno solo. Por eso el locker atiende UNA operacion por vez y
 * el switch se le atribuye a quien la inicio: asi la trazabilidad puede decir
 * quien fue el ultimo que cerro la puerta.
 *
 * El backend nunca asume que la puerta se abrio porque mando la orden: el
 * estado lo decide el microswitch.
 */
const { db } = require('../config/database');
const env = require('../config/env');
const reloj = require('../utils/reloj');
const log = require('../utils/logger');
const hub = require('../realtime/hub');
const { ErrorNegocio } = require('../utils/errores');
const lockers = require('./locker.service');
const prestamos = require('./prestamo.service');
const comandos = require('./comando.service');
const auditoria = require('./auditoria.service');
const eventos = require('./evento.service');
const { alertar, NIVELES } = require('./alerta.service');

const R = env.reglas;
const MIN = 60000;
const PULSO_MS = () => R.pulsoAperturaSeg * 1000;
// Margen para el viaje por radio antes de que el nodo confirme (ACK).
const MARGEN_TRANSPORTE_MS = 3000;

/* ============================================================
   Estado de una operacion (lo que ve la pantalla del locker)
   ============================================================ */

const TERMINADOS = {
  RETIRO: ['EN_USO', 'EN_MORA', 'BUFFER_30_MIN', 'PENDIENTE_AUDITORIA', 'FINALIZADO'],
  DEVOLUCION: ['BUFFER_30_MIN', 'PENDIENTE_AUDITORIA', 'FINALIZADO'],
};
const REINTENTABLES = { RETIRO: ['RESERVADO'], DEVOLUCION: ['EN_USO', 'EN_MORA'] };

/**
 * Fases:
 *   enviando      la orden va por radio, el nodo todavia no confirmo
 *   pulso         solenoide energizado: hay que tirar de la puerta ahora
 *   sin_apertura  pasaron los 15 s y el switch nunca reporto ABIERTO
 *   abierta       la puerta esta abierta (retirar / depositar y cerrar)
 *   finalizada    la puerta se cerro y el prestamo cambio de estado
 *   cancelada     la reserva ya no admite esta operacion
 */
function estado(lockerId, prestamoId, tipo) {
  const l = lockers.fila(lockerId);
  const p = prestamos.fila(prestamoId);
  if (!l || !p) return null;

  const t = reloj.ahoraMs();
  const vivo = l.op_prestamo_id === p.id && l.op_tipo === tipo;
  let fase;
  let motivo = null;
  let comando = null;

  if (vivo) {
    comando = l.op_comando_id ? comandos.obtener(l.op_comando_id) : null;
    if (l.estado_puerta === 'ABIERTO') fase = 'abierta';
    else if (comando && comando.estado === 'fallido') {
      fase = 'sin_apertura';
      motivo = 'El locker no respondió a la orden de apertura';
    } else if (comando && ['pendiente', 'enviado'].includes(comando.estado)) fase = 'enviando';
    else if (t < Date.parse(l.op_pulso_hasta)) fase = 'pulso';
    else {
      fase = 'sin_apertura';
      motivo = `Pasaron los ${R.pulsoAperturaSeg} segundos y el sensor no registró la puerta abierta`;
    }
  } else if (TERMINADOS[tipo].includes(p.estado)) fase = 'finalizada';
  else if (REINTENTABLES[tipo].includes(p.estado)) {
    fase = 'sin_apertura';
    motivo = 'La apertura anterior venció sin que se abriera la puerta';
  } else fase = 'cancelada';

  const pulsoHasta = vivo ? l.op_pulso_hasta : null;
  return {
    tipo,
    fase,
    motivo,
    puedeReintentar: fase === 'sin_apertura',
    pulsoHasta,
    pulsoSeg: R.pulsoAperturaSeg,
    segundosRestantesPulso: pulsoHasta ? Math.max(0, Math.ceil((Date.parse(pulsoHasta) - t) / 1000)) : 0,
    abiertaDesde: vivo ? l.abierta_desde : null,
    segundosAbierta: vivo && l.abierta_desde ? Math.max(0, Math.round((t - Date.parse(l.abierta_desde)) / 1000)) : null,
    alertaPuertaAbierta: vivo && Boolean(l.alerta_puerta_enviada),
    alertaSeg: R.alertaPuertaAbiertaSeg,
    comando: comando ? { id: comando.id, estado: comando.estado, intentos: comando.intentos } : null,
    locker: { id: l.id, descripcionItem: l.descripcion_item },
    prestamo: {
      id: p.id,
      estado: p.estado,
      cantidad: p.cantidad,
      descripcionItem: p.descripcion_item,
      fechaReserva: p.fecha_reserva,
      horaInicio: p.hora_inicio,
      horaLimite: p.hora_limite,
      caminoDevolucion: p.camino_devolucion,
      nombre: p.usuario_nombre,
    },
  };
}

/** Empuja el estado de la operacion a la pantalla del locker y a la app del dueño. */
function notificar(lockerId, prestamoId, tipo) {
  const datos = estado(lockerId, prestamoId, tipo);
  if (!datos) return;
  hub.emitirALocker(lockerId, 'operacion.actualizada', datos);
  hub.emitirA(prestamos.fila(prestamoId)?.legajo_usuario, 'operacion.actualizada', datos);
}

/* ============================================================
   Inicio, reintento
   ============================================================ */

/** Que operacion corresponde a un prestamo segun su estado. */
function tipoPara(p) {
  if (p.estado === 'RESERVADO') return 'RETIRO';
  if (p.estado === 'EN_USO' || p.estado === 'EN_MORA') return 'DEVOLUCION';
  return null;
}

/** Reglas de tiempo y disciplina para retirar (spec, Fase 2.2). */
function validarRetiro(p) {
  const t = reloj.ahoraMs();
  const inicio = Date.parse(p.inicio_ts);
  if (p.sancionado)
    throw new ErrorNegocio('Tu legajo está sancionado: acercate a la Mesa de Alumnado', 403);
  if (p.requiere_respaldo)
    throw new ErrorNegocio('Este turno se entrega en la ventanilla de Alumnado (sin stock en los lockers)', 409);
  if (t < inicio)
    throw new ErrorNegocio(`Tu retiro se habilita a las ${p.hora_inicio} del ${p.fecha_reserva}`, 409);
  if (p.intentos_apertura === 0 && t > inicio + R.toleranciaRetiroMin * MIN)
    throw new ErrorNegocio(`Venció la tolerancia de ${R.toleranciaRetiroMin} minutos para retirar`, 409);
  if (t >= Date.parse(p.limite_ts)) throw new ErrorNegocio('La franja de la reserva ya terminó', 409);
}

/**
 * Inicia (o reintenta) una operacion: encola el pulso de 15 s y deja el
 * locker "tomado" por este prestamo hasta que la puerta se cierre.
 *
 * Si la operacion ya existe y su pulso termino sin apertura, cuenta como
 * reintento (no penaliza la reserva). Si el pulso todavia corre, no se manda
 * otro: devuelve la misma operacion.
 */
function iniciar(prestamoId, { tipo = null, reintento = false, origen = 'usuario' } = {}) {
  const p = prestamos.fila(prestamoId);
  if (!p) throw new ErrorNegocio('La reserva no existe', 404);
  const tipoReal = tipo || tipoPara(p);
  if (!tipoReal || tipoPara(p) !== tipoReal)
    throw new ErrorNegocio('Esta reserva no admite una apertura en este momento', 409);
  if (tipoReal === 'RETIRO') validarRetiro(p);

  const l = lockers.fila(p.locker_id);
  if (l.estado_operativo === 'error')
    throw new ErrorNegocio(`El locker ${l.id} está fuera de servicio: acercate a la Mesa de Alumnado`, 409);

  const propia = l.op_tipo && l.op_prestamo_id === p.id && l.op_tipo === tipoReal;
  if (l.op_tipo && !propia)
    throw new ErrorNegocio('El locker está siendo usado por otra persona. Esperá a que cierre la puerta y probá de nuevo.', 409);
  if (!l.op_tipo && l.estado_puerta === 'ABIERTO')
    throw new ErrorNegocio('La puerta del locker está abierta. Cerrala y volvé a ingresar el código.', 409);

  const t = reloj.ahoraMs();
  let esReintento = reintento;
  if (propia) {
    if (l.estado_puerta === 'ABIERTO' || l.op_abrio) return { ...estado(l.id, p.id, tipoReal), nueva: false };
    const comando = l.op_comando_id ? comandos.obtener(l.op_comando_id) : null;
    const pulsoTerminado = t >= Date.parse(l.op_pulso_hasta) || (comando && comando.estado === 'fallido');
    if (!pulsoTerminado) return { ...estado(l.id, p.id, tipoReal), nueva: false };
    esReintento = true;
  }

  const comando = comandos.encolarApertura(l.id, {
    origen,
    solicitadoPor: p.legajo_usuario,
    motivo: tipoReal,
    prestamoId: p.id,
  });

  const enTermino = tipoReal === 'DEVOLUCION' ? (p.estado === 'EN_USO' && t <= Date.parse(p.limite_ts) ? 1 : 0) : null;
  db.prepare(
    `UPDATE lockers SET op_tipo = ?, op_prestamo_id = ?, op_legajo = ?,
            op_iniciada_en = COALESCE(CASE WHEN op_prestamo_id = ? AND op_tipo = ? THEN op_iniciada_en END, ?),
            op_pulso_hasta = ?, op_comando_id = ?, op_abrio = 0,
            op_en_termino = COALESCE(CASE WHEN op_prestamo_id = ? AND op_tipo = ? THEN op_en_termino END, ?)
     WHERE id = ?`
  ).run(
    tipoReal, p.id, p.legajo_usuario,
    p.id, tipoReal, reloj.ahora(),
    reloj.iso(t + PULSO_MS() + MARGEN_TRANSPORTE_MS), comando.id,
    p.id, tipoReal, enTermino,
    l.id
  );

  if (tipoReal === 'RETIRO') prestamos.sumarIntento(p.id);

  const evento = esReintento
    ? auditoria.EVENTOS.REINTENTO_APERTURA
    : tipoReal === 'RETIRO'
      ? auditoria.EVENTOS.PULSO_APERTURA_RETIRO
      : auditoria.EVENTOS.PULSO_APERTURA_DEVOLUCION;
  auditoria.registrar(evento, {
    lockerId: l.id,
    legajo: p.legajo_usuario,
    prestamoId: p.id,
    detalle: `${tipoReal} · ${p.cantidad} x ${p.descripcion_item} · pulso ${R.pulsoAperturaSeg} s (comando #${comando.id})`,
  });

  lockers.notificar(l.id);
  notificar(l.id, p.id, tipoReal);
  prestamos.emitir(p.id);
  return { ...estado(l.id, p.id, tipoReal), nueva: !esReintento };
}

/**
 * Pantalla del QR: valida el codigo contra ESE locker y arranca lo que
 * corresponda (retiro o devolucion).
 */
function accesoConCodigo(lockerId, codigo) {
  const id = String(lockerId || '').toUpperCase();
  const l = lockers.fila(id);
  if (!l) throw new ErrorNegocio('El locker no existe', 404);
  const limpio = String(codigo || '').replace(/\D/g, '');
  if (limpio.length !== 6) throw new ErrorNegocio('El código tiene 6 dígitos', 400);

  const p = db.prepare(`SELECT id, locker_id, estado FROM prestamos WHERE codigo_operacion = ?`).get(limpio);
  const vigente = p && prestamos.ESTADOS_CON_CODIGO.includes(p.estado);
  if (!vigente) {
    const error = new ErrorNegocio('Código inválido o vencido', 401);
    error.codigoIncorrecto = true;
    throw error;
  }
  if (p.locker_id !== id)
    throw new ErrorNegocio(`Ese código corresponde al locker ${p.locker_id}. Escaneá el QR de esa puerta.`, 409);

  return iniciar(p.id, { origen: 'usuario' });
}

/** "Iniciar Devolucion" desde la sesion activa de la app (spec 3.1.2). */
function devolucionDesdeSesion(prestamoId, legajo) {
  const p = prestamos.fila(prestamoId);
  if (!p) throw new ErrorNegocio('El préstamo no existe', 404);
  if (p.legajo_usuario !== legajo) throw new ErrorNegocio('Ese préstamo no es tuyo', 403);
  if (!['EN_USO', 'EN_MORA'].includes(p.estado))
    throw new ErrorNegocio('Ese préstamo no tiene material para devolver', 409);
  return iniciar(p.id, { tipo: 'DEVOLUCION' });
}

/** Boton "Reintentar Apertura". */
const reintentar = (prestamoId, tipo) => iniciar(prestamoId, { tipo, reintento: true });

/* ============================================================
   Reporte de faltante o dano (spec, Fase 2.5)
   ============================================================ */

/**
 * La persona abre y encuentra menos unidades (o algo roto). Se registra el
 * incidente y se cruza quien fue el ULTIMO legajo que cerro ese locker antes:
 * ese es el presunto responsable que ve Alumnado.
 */
function reportarIncidencia(prestamoId, { legajo, detalle }) {
  const p = prestamos.fila(prestamoId);
  if (!p) throw new ErrorNegocio('El préstamo no existe', 404);
  if (legajo && p.legajo_usuario !== legajo) throw new ErrorNegocio('Ese préstamo no es tuyo', 403);
  if (!['RESERVADO', 'EN_USO', 'EN_MORA'].includes(p.estado))
    throw new ErrorNegocio('Solo se reporta un faltante durante el retiro o mientras tenés el material', 409);

  const texto = String(detalle || '').trim().slice(0, 500) || 'Faltante o daño reportado al abrir el locker';
  // Si ya retiro, lo previo es lo anterior a SU apertura; si no, lo anterior a ahora.
  const antesDe = p.timestamp_retiro || reloj.ahora();
  const previo = auditoria.ultimoCierrePrevio(p.locker_id, { antesDe, excluirPrestamoId: p.id });

  const incidenciaId = auditoria.registrar(auditoria.EVENTOS.REPORTE_FALTANTE_O_DANO, {
    lockerId: p.locker_id,
    legajo: p.legajo_usuario,
    prestamoId: p.id,
    detalle: texto,
    ultimoResponsable: previo ? previo.legajo_usuario : null,
  });

  const responsable = previo
    ? `${previo.nombre || previo.legajo_usuario} (${previo.legajo_usuario}), cerró el ${reloj.fechaLocal(Date.parse(previo.timestamp))} a las ${reloj.horaLocal(Date.parse(previo.timestamp))}`
    : 'sin cierres previos registrados';

  alertar({
    tipo: 'FALTANTE',
    nivel: NIVELES.CRITICA,
    mensaje: `Faltante/incidencia en ${p.locker_id} reportado por ${p.usuario_nombre} (${p.legajo_usuario}): "${texto}". Presunto responsable: ${responsable}.`,
    lockerId: p.locker_id,
    prestamoId: p.id,
    incidenciaId,
  });

  return {
    incidenciaId,
    presuntoResponsable: previo ? { legajo: previo.legajo_usuario, nombre: previo.nombre } : null,
  };
}

/* ============================================================
   Apertura de emergencia (Alumnado)
   ============================================================ */

function aperturaEmergencia(lockerId, { actor }) {
  const l = lockers.fila(String(lockerId || '').toUpperCase());
  if (!l) throw new ErrorNegocio('El locker no existe', 404);
  if (l.estado_puerta === 'ABIERTO') throw new ErrorNegocio('La puerta ya está abierta', 409);

  const comando = comandos.encolarApertura(l.id, {
    origen: 'admin', solicitadoPor: actor, motivo: 'EMERGENCIA', prestamoId: l.op_prestamo_id || null,
  });
  const pulsoHasta = reloj.iso(reloj.ahoraMs() + PULSO_MS() + MARGEN_TRANSPORTE_MS);

  if (l.op_tipo) {
    // Una persona esta frente a la puerta y no abre: Alumnado le da un pulso
    // mas, pero la operacion (y la atribucion del switch) sigue siendo suya.
    db.prepare(`UPDATE lockers SET op_pulso_hasta = ?, op_comando_id = ? WHERE id = ?`)
      .run(pulsoHasta, comando.id, l.id);
  } else {
    db.prepare(
      `UPDATE lockers SET op_tipo = 'EMERGENCIA', op_prestamo_id = NULL, op_legajo = ?, op_iniciada_en = ?,
              op_pulso_hasta = ?, op_comando_id = ?, op_abrio = 0, op_en_termino = NULL
       WHERE id = ?`
    ).run(actor, reloj.ahora(), pulsoHasta, comando.id, l.id);
  }

  eventos.registrar(eventos.TIPOS.APERTURA_EMERGENCIA, {
    lockerId: l.id, actor, prestamoId: l.op_prestamo_id || null,
    detalle: l.op_tipo ? `pulso extra para la operación de ${l.op_legajo}` : `comando #${comando.id}`,
  });
  lockers.notificar(l.id);
  if (l.op_prestamo_id) notificar(l.id, l.op_prestamo_id, l.op_tipo);
  return { comandoId: comando.id, locker: lockers.obtener(l.id) };
}

/* ============================================================
   Ganchos del hardware
   ============================================================ */

/** Limpia la operacion del locker. */
const liberar = (lockerId) =>
  db.prepare(
    `UPDATE lockers SET op_tipo = NULL, op_prestamo_id = NULL, op_legajo = NULL, op_iniciada_en = NULL,
            op_pulso_hasta = NULL, op_comando_id = NULL, op_abrio = 0, op_en_termino = NULL
     WHERE id = ?`
  ).run(lockerId);

/**
 * Lo llama telemetria.service cuando el microswitch CAMBIA de estado.
 * @param {object} antes   fila del locker ANTES de aplicar la lectura
 * @param {boolean} abierta lectura nueva
 */
function alCambiarPuerta(antes, abierta) {
  const lockerId = antes.id;
  const legajo = antes.op_legajo || auditoria.SIN_RESPONSABLE;
  const prestamoId = antes.op_prestamo_id || null;

  if (abierta) {
    auditoria.registrar(auditoria.EVENTOS.PUERTA_ABIERTA, { lockerId, legajo, prestamoId });
    if (antes.op_tipo) {
      db.prepare(`UPDATE lockers SET op_abrio = 1 WHERE id = ?`).run(lockerId);
      if (prestamoId) notificar(lockerId, prestamoId, antes.op_tipo);
    } else {
      eventos.registrar(eventos.TIPOS.APERTURA_SIN_OPERACION, {
        lockerId, actor: 'microswitch', detalle: 'El switch reportó ABIERTO sin una apertura autorizada',
      });
      alertar({
        tipo: 'APERTURA_SIN_OPERACION',
        nivel: NIVELES.CRITICA,
        mensaje: `La puerta de ${lockerId} se abrió sin una apertura autorizada`,
        lockerId,
      });
    }
    return;
  }

  // ---- La puerta se cerro ----
  auditoria.registrar(auditoria.EVENTOS.PUERTA_CERRADA, { lockerId, legajo, prestamoId });
  if (!antes.op_tipo || !(antes.op_abrio || antes.estado_puerta === 'ABIERTO')) return;

  // Se libera el locker ANTES de cambiar el prestamo: el siguiente en la fila
  // ya puede validar su codigo.
  liberar(lockerId);

  if (antes.op_tipo === 'RETIRO' && prestamoId) {
    prestamos.marcarRetirado(prestamoId, { timestampRetiro: antes.abierta_desde || reloj.ahora() });
  } else if (antes.op_tipo === 'DEVOLUCION' && prestamoId) {
    prestamos.registrarDevolucion(prestamoId, { enTermino: Boolean(antes.op_en_termino) });
  }
  if (prestamoId) notificar(lockerId, prestamoId, antes.op_tipo);
}

/** ACK del nodo: el pulso de 15 s arranca en serio desde ahora. */
comandos.avisos.on('confirmado', (comando) => {
  const l = lockers.fila(comando.locker_id);
  if (!l || l.op_comando_id !== comando.id) return;
  db.prepare(`UPDATE lockers SET op_pulso_hasta = ? WHERE id = ?`)
    .run(reloj.iso(reloj.ahoraMs() + PULSO_MS()), l.id);
  lockers.notificar(l.id);
  if (l.op_prestamo_id) notificar(l.id, l.op_prestamo_id, l.op_tipo);
});

comandos.avisos.on('fallido', (comando) => {
  const l = lockers.fila(comando.locker_id);
  if (!l || l.op_comando_id !== comando.id) return;
  lockers.notificar(l.id);
  if (l.op_prestamo_id) notificar(l.id, l.op_prestamo_id, l.op_tipo);
});

/* ============================================================
   Watchdog
   ============================================================ */

function vigilar() {
  const t = reloj.ahoraMs();

  // 1. Operaciones que nunca abrieron la puerta: se abandonan para liberar
  //    el locker. La reserva no se penaliza: puede volver a intentar.
  const abandonadas = db
    .prepare(`SELECT * FROM lockers WHERE op_tipo IS NOT NULL AND op_abrio = 0 AND estado_puerta = 'CERRADO'
              AND op_pulso_hasta < ?`)
    .all(reloj.iso(t - R.operacionAbandonoSeg * 1000));
  for (const l of abandonadas) {
    liberar(l.id);
    lockers.notificar(l.id);
    if (l.op_prestamo_id) notificar(l.id, l.op_prestamo_id, l.op_tipo);
  }

  // 2. Puerta mal cerrada: alerta a los 45 s (una vez por apertura).
  const malCerradas = db
    .prepare(`SELECT * FROM lockers WHERE estado_puerta = 'ABIERTO' AND abierta_desde IS NOT NULL
              AND abierta_desde <= ? AND alerta_puerta_enviada = 0`)
    .all(reloj.iso(t - R.alertaPuertaAbiertaSeg * 1000));
  for (const l of malCerradas) {
    db.prepare(`UPDATE lockers SET alerta_puerta_enviada = 1 WHERE id = ?`).run(l.id);
    const mensaje = `¡Atención! Puerta del Locker ${l.id} mal cerrada. Por favor presione la puerta hasta escuchar la traba`;
    auditoria.registrar(auditoria.EVENTOS.ALERTA_PUERTA_ABIERTA, {
      lockerId: l.id,
      legajo: l.op_legajo || auditoria.SIN_RESPONSABLE,
      prestamoId: l.op_prestamo_id,
      detalle: `Abierta hace más de ${R.alertaPuertaAbiertaSeg} s`,
    });
    const legajo = l.op_prestamo_id ? prestamos.fila(l.op_prestamo_id)?.legajo_usuario : null;
    alertar(
      { tipo: 'PUERTA_ABIERTA', nivel: NIVELES.CRITICA, mensaje, lockerId: l.id, prestamoId: l.op_prestamo_id },
      { usuario: legajo, locker: l.id }
    );
    lockers.notificar(l.id);
    if (l.op_prestamo_id) notificar(l.id, l.op_prestamo_id, l.op_tipo);
    log.aviso(`Locker ${l.id}: puerta abierta hace mas de ${R.alertaPuertaAbiertaSeg} s`);
  }

  // 3. Puerta abierta demasiado tiempo: se considera trabada -> ERROR.
  const trabadas = db
    .prepare(`SELECT id FROM lockers WHERE estado_puerta = 'ABIERTO' AND abierta_desde IS NOT NULL
              AND abierta_desde < ? AND estado_operativo = 'ok'`)
    .all(reloj.iso(t - R.puertaAbiertaMaxSeg * 1000));
  for (const l of trabadas) {
    lockers.marcarOperativo(l.id, false, `Puerta abierta hace más de ${R.puertaAbiertaMaxSeg} s`);
    eventos.registrar(eventos.TIPOS.PUERTA_TRABADA, { lockerId: l.id, actor: 'watchdog' });
    lockers.notificar(l.id);
    log.aviso(`Locker ${l.id} marcado en ERROR (puerta abierta)`);
  }
}

module.exports = {
  estado, notificar, iniciar, accesoConCodigo, devolucionDesdeSesion, reintentar,
  reportarIncidencia, aperturaEmergencia, alCambiarPuerta, vigilar, liberar,
};
