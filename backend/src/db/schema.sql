-- ============================================================
--  Esquema v4 - Panol automatizado UNRaf (Lockers UNRaf)
--
--  Las cuatro tablas centrales (usuarios, lockers, prestamos,
--  logs_auditoria) siguen la especificacion tecnica: mismos nombres,
--  mismas columnas y mismos CHECK. Lo que se agrega va marcado con
--  "EXTENSION" y existe porque el flujo lo necesita (ver
--  MODELO-DE-DATOS.md, seccion 2).
--
--  Tablas de apoyo: nodos (placas), comandos (cola hacia la radio)
--  y eventos (bitacora de negocio: aprobaciones, mora, sanciones...).
--
--  Fechas:
--    fecha_reserva / hora_inicio / hora_limite / hora_fin_buffer
--      -> hora LOCAL del panol, para mostrar ('2026-10-16', '15:00')
--    *_ts, timestamp_*, creado_en
--      -> instantes ISO-8601 UTC, para calcular
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 1. Usuarios y estado disciplinario ----------
-- Alumnos, docentes y Alumnado en un solo padron. Alumnado entra con
-- legajo = 'alumnado' y su clave hasheada en pin_hash.
CREATE TABLE IF NOT EXISTS usuarios (
  legajo         TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  rol            TEXT CHECK (rol IN ('alumno', 'docente', 'admin')) NOT NULL,
  pin_hash       TEXT NOT NULL,                 -- bcrypt: el PIN nunca se guarda en claro
  sancionado     INTEGER DEFAULT 0,             -- 0: Activo, 1: Bloqueado por mora o faltante
  motivo_sancion TEXT,
  -- EXTENSION: baja logica. Un usuario con historial nunca se borra.
  activo         INTEGER NOT NULL DEFAULT 1,
  sancionado_en  TEXT
);

-- ---------- Hardware: una placa ESP32 XIAO por gabinete ----------
CREATE TABLE IF NOT EXISTS nodos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT    NOT NULL UNIQUE,
  ubicacion       TEXT,
  rssi            INTEGER,
  bateria_mv      INTEGER,
  ultimo_contacto TEXT
);

-- ---------- 2. Lockers e inventario fisico ----------
CREATE TABLE IF NOT EXISTS lockers (
  id                  TEXT PRIMARY KEY,          -- 'A-01', 'A-02'
  descripcion_item    TEXT NOT NULL,
  capacidad_maxima    INTEGER NOT NULL,
  -- Unidades que pertenecen al locker y estan en servicio (adentro o prestadas).
  -- Lo que se puede reservar en una franja se DERIVA de aca restando lo que
  -- bloquean los prestamos que se superponen (ver lockers.service.js).
  stock_actual_fisico INTEGER NOT NULL,
  estado_puerta       TEXT CHECK (estado_puerta IN ('CERRADO', 'ABIERTO')) DEFAULT 'CERRADO',

  -- EXTENSION: datos de presentacion
  categoria           TEXT,
  -- EXTENSION: a que placa y salida esta cableada la cerradura
  nodo_id             INTEGER REFERENCES nodos(id),
  bit_registro        INTEGER,
  -- EXTENSION: salud del locker (puerta trabada, comando sin ACK)
  estado_operativo    TEXT NOT NULL DEFAULT 'ok' CHECK (estado_operativo IN ('ok', 'error')),
  detalle_error       TEXT,
  abierta_desde       TEXT,                      -- cuando el switch reporto ABIERTO
  alerta_puerta_enviada INTEGER NOT NULL DEFAULT 0, -- alerta de los 45 s ya disparada
  ultima_telemetria   TEXT,
  -- EXTENSION: operacion fisica en curso. Varios prestamos comparten un
  -- locker, pero la puerta es una sola: el switch se le atribuye a quien
  -- valido el codigo. Un locker atiende una operacion por vez.
  op_tipo             TEXT CHECK (op_tipo IN ('RETIRO', 'DEVOLUCION', 'EMERGENCIA')),
  op_prestamo_id      INTEGER,
  op_legajo           TEXT,
  op_iniciada_en      TEXT,
  op_pulso_hasta      TEXT,                      -- fin estimado del pulso de 15 s
  op_comando_id       INTEGER,
  op_abrio            INTEGER NOT NULL DEFAULT 0,-- el switch llego a reportar ABIERTO
  op_en_termino       INTEGER,                   -- devolucion iniciada antes de hora_limite
  UNIQUE (nodo_id, bit_registro)
);

-- ---------- 3. Prestamos y reservas por franja horaria ----------
CREATE TABLE IF NOT EXISTS prestamos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  legajo_usuario       TEXT NOT NULL,
  locker_id            TEXT NOT NULL,
  cantidad             INTEGER NOT NULL,
  codigo_operacion     TEXT UNIQUE NOT NULL,     -- 6 digitos; se muestra recien en RESERVADO
  fecha_reserva        DATE NOT NULL,
  hora_inicio          TIME NOT NULL,
  duracion_horas       INTEGER CHECK (duracion_horas IN (1, 2, 3, 4)) NOT NULL,
  hora_limite          TIME NOT NULL,            -- hora_inicio + duracion_horas
  hora_fin_buffer      TIME NOT NULL,            -- hora_limite + 30 min
  estado               TEXT CHECK (estado IN (
                         'PENDIENTE_APROBACION',
                         'RECHAZADO',
                         'RESERVADO',
                         'CANCELADO_NO_SHOW',
                         'EN_USO',
                         'EN_MORA',
                         'BUFFER_30_MIN',
                         'PENDIENTE_AUDITORIA',
                         'FINALIZADO',
                         -- EXTENSION: la persona (o Alumnado) cancela una reserva vigente.
                         -- La regla del docente lo exige: "se habilita una nueva recien al
                         -- concretar o cancelar la vigente".
                         'CANCELADO'
                       )) NOT NULL,
  timestamp_retiro     DATETIME,
  timestamp_devolucion DATETIME,

  -- EXTENSION: la misma franja como instantes UTC (las consultas comparan esto)
  inicio_ts            TEXT NOT NULL,
  limite_ts            TEXT NOT NULL,
  fin_buffer_ts        TEXT NOT NULL,
  -- EXTENSION: foto del material al reservar. Si Alumnado cambia lo que guarda
  -- el locker, el historial tiene que seguir diciendo la verdad.
  descripcion_item     TEXT NOT NULL,
  creado_en            TEXT NOT NULL,
  requiere_aprobacion  INTEGER NOT NULL DEFAULT 0,
  resuelto_por         TEXT,
  resuelto_en          TEXT,
  motivo_rechazo       TEXT,
  intentos_apertura    INTEGER NOT NULL DEFAULT 0,  -- pulsos pedidos para retirar
  devolucion_en_termino INTEGER,
  camino_devolucion    TEXT CHECK (camino_devolucion IN ('A', 'B')),
  mora_desde           TEXT,
  auditado_por         TEXT,
  auditado_en          TEXT,
  unidades_recibidas   INTEGER,
  -- Mitigacion del turno siguiente (Fase 4.3)
  locker_original_id   TEXT,                       -- si se reasigno a otro locker
  requiere_respaldo    INTEGER NOT NULL DEFAULT 0, -- entregar en ventanilla
  entregado_en_ventanilla INTEGER NOT NULL DEFAULT 0,

  FOREIGN KEY (legajo_usuario) REFERENCES usuarios(legajo),
  FOREIGN KEY (locker_id) REFERENCES lockers(id),
  CHECK (cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_prestamos_locker  ON prestamos (locker_id, estado, inicio_ts);
CREATE INDEX IF NOT EXISTS idx_prestamos_usuario ON prestamos (legajo_usuario, estado);
CREATE INDEX IF NOT EXISTS idx_prestamos_estado  ON prestamos (estado, inicio_ts);

-- ---------- 4. Trazabilidad de aperturas y reportes de faltantes ----------
CREATE TABLE IF NOT EXISTS logs_auditoria (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  locker_id                 TEXT NOT NULL,
  legajo_usuario            TEXT NOT NULL,
  prestamo_id               INTEGER,
  evento                    TEXT CHECK (evento IN (
                              'PULSO_APERTURA_RETIRO',
                              'PUERTA_ABIERTA',
                              'PUERTA_CERRADA',
                              'REINTENTO_APERTURA',
                              'ALERTA_PUERTA_ABIERTA',
                              'PULSO_APERTURA_DEVOLUCION',
                              'REPORTE_FALTANTE_O_DANO'
                            )) NOT NULL,
  detalle_reporte           TEXT,
  ultimo_responsable_previo TEXT,                  -- autocompletado al reportar un faltante
  timestamp                 DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- EXTENSION: Alumnado marca el reporte como resuelto y deja de verlo en alertas
  revisado                  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_logs_locker ON logs_auditoria (locker_id, evento, id DESC);

-- ---------- Cola de ordenes hacia los nodos ----------
-- Retiro y devolucion generan EXACTAMENTE la misma orden fisica: energizar el
-- solenoide durante duracion_ms. El motivo existe solo para la bitacora.
CREATE TABLE IF NOT EXISTS comandos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  locker_id      TEXT    NOT NULL REFERENCES lockers(id),
  prestamo_id    INTEGER REFERENCES prestamos(id),
  tipo           TEXT    NOT NULL,             -- 'ABRIR' | 'PING'
  motivo         TEXT    NOT NULL DEFAULT 'RETIRO', -- RETIRO | DEVOLUCION | EMERGENCIA
  duracion_ms    INTEGER NOT NULL DEFAULT 15000,
  origen         TEXT    NOT NULL,             -- 'usuario' | 'admin' | 'sistema'
  solicitado_por TEXT,
  estado         TEXT    NOT NULL DEFAULT 'pendiente', -- pendiente|enviado|confirmado|fallido
  intentos       INTEGER NOT NULL DEFAULT 0,
  creado_en      TEXT    NOT NULL,
  enviado_en     TEXT,
  confirmado_en  TEXT,
  detalle        TEXT
);

CREATE INDEX IF NOT EXISTS idx_comandos_pendientes ON comandos (estado, creado_en);

-- ---------- Bitacora de negocio ----------
-- logs_auditoria guarda lo FISICO (pulsos, puerta, faltantes). Esta tabla
-- guarda las decisiones: solicitudes, aprobaciones, no-show, mora, sanciones,
-- auditorias y reasignaciones.
CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  locker_id   TEXT,
  prestamo_id INTEGER,
  tipo        TEXT NOT NULL,
  detalle     TEXT,
  actor       TEXT,
  creado_en   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos (creado_en DESC);
