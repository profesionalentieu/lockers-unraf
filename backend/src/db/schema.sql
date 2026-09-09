-- ============================================================
--  Esquema v2 - Panol inteligente UNRaf
--  Cambio respecto de v1: los casilleros ya no se le prestan a
--  una persona, guardan MATERIAL. Lo que se presta es el item,
--  y el casillero pasa a ser el contenedor + la cerradura.
--
--  Fechas: texto ISO-8601 UTC en toda la base.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Personas ----------

-- Un solo padron para alumnos y docentes: los dos retiran material.
-- El rol solo cambia limites y permisos, no el circuito.
CREATE TABLE IF NOT EXISTS usuarios (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  legajo   TEXT    NOT NULL UNIQUE,
  nombre   TEXT    NOT NULL,
  -- Segundo factor simple del MVP (4 a 6 digitos). En produccion: SSO.
  pin      TEXT    NOT NULL,
  rol      TEXT    NOT NULL DEFAULT 'alumno',   -- 'alumno' | 'docente'
  activo   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS administrativos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario       TEXT    NOT NULL UNIQUE,
  nombre        TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  activo        INTEGER NOT NULL DEFAULT 1
);

-- ---------- Hardware ----------

-- Un nodo = una placa XIAO ESP32S3 que controla un gabinete, por ESP-NOW.
CREATE TABLE IF NOT EXISTS nodos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT    NOT NULL UNIQUE,
  ubicacion       TEXT,
  rssi            INTEGER,
  bateria_mv      INTEGER,
  ultimo_contacto TEXT
);

-- ---------- Catalogo ----------

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo      TEXT    NOT NULL UNIQUE,      -- 'NB-14', 'ZAP-5M'
  nombre      TEXT    NOT NULL,             -- 'Notebook Lenovo 14"'
  categoria   TEXT,                         -- 'Informatica' | 'Electricidad' | ...
  unidad      TEXT    NOT NULL DEFAULT 'unidad',
  descripcion TEXT,
  activo      INTEGER NOT NULL DEFAULT 1
);

-- ---------- Casilleros ----------
-- Cada casillero guarda UN tipo de item. La relacion es 1 item -> N casilleros
-- (si mañana entran 40 fibrones, se reparten en dos casilleros del mismo item)
-- pero cada casillero apunta a un solo item, que es lo que pide el prototipo.
CREATE TABLE IF NOT EXISTS casilleros (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo            TEXT    NOT NULL UNIQUE,
  nodo_id           INTEGER NOT NULL REFERENCES nodos(id),
  -- Bit del SN74HC595 que dispara el MOSFET IRLZ44N de esta puerta (0..7)
  bit_registro      INTEGER NOT NULL,
  item_id           INTEGER REFERENCES items(id),   -- NULL = casillero vacio
  stock_total       INTEGER NOT NULL DEFAULT 0,     -- cuanto deberia haber adentro
  umbral_bajo       INTEGER NOT NULL DEFAULT 0,     -- avisar cuando disponible <= umbral
  estado_puerta     TEXT    NOT NULL DEFAULT 'desconocida',  -- microswitch
  estado_operativo  TEXT    NOT NULL DEFAULT 'ok',           -- 'ok' | 'error'
  detalle_error     TEXT,
  abierta_desde     TEXT,
  ultima_telemetria TEXT,
  UNIQUE (nodo_id, bit_registro)
);

-- ---------- Prestamos (el corazon del sistema) ----------
-- OJO: NO existe una columna 'stock_disponible'. El disponible se calcula
-- como stock_total - SUM(cantidad - cantidad_devuelta) de los prestamos
-- activos de ese casillero. Ver casillero.service.js.
-- Guardarlo como columna es lo que produce inventarios en negativo cuando
-- una operacion falla a mitad de camino.
CREATE TABLE IF NOT EXISTS prestamos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id        INTEGER NOT NULL REFERENCES usuarios(id),
  casillero_id      INTEGER NOT NULL REFERENCES casilleros(id),
  -- Se guarda el item ademas del casillero: si mañana Alumnado reasigna el
  -- casillero a otro material, el historico tiene que seguir diciendo la verdad.
  item_id           INTEGER NOT NULL REFERENCES items(id),
  cantidad          INTEGER NOT NULL CHECK (cantidad > 0),
  cantidad_devuelta INTEGER NOT NULL DEFAULT 0,
  -- Ciclo de vida:
  --   pendiente  -> solicitado, esperando que Alumnado apruebe
  --   aprobado   -> Alumnado dio el visto bueno y emitio el codigo.
  --                 El material sigue ADENTRO: nadie abrio nada todavia.
  --   activo     -> la persona uso el codigo en el locker y retiro
  --   devuelto   -> uso el codigo por segunda vez y guardo el material
  --   rechazado  -> Alumnado lo denego
  --   caducado   -> nadie lo aprobo a tiempo, o el codigo vencio sin usarse
  estado            TEXT    NOT NULL DEFAULT 'pendiente',
  vencido           INTEGER NOT NULL DEFAULT 0,         -- fuera de plazo de devolucion
  solicitado_en     TEXT    NOT NULL,
  -- Momento en que Alumnado aprobo y se abrio el casillero. NULL mientras
  -- la solicitud espera: no se puede decir que retiro algo que no le dieron.
  retirado_en       TEXT,
  vencimiento       TEXT,                               -- se calcula al aprobar
  devuelto_en       TEXT,
  resuelto_por      TEXT,                               -- quien aprobo o rechazo
  resuelto_en       TEXT,
  motivo_rechazo    TEXT,
  observaciones     TEXT,

  -- ---- Codigo de apertura ----
  -- Se emite al aprobar. La persona lo ingresa en la pagina a la que lleva
  -- el QR pegado en el locker, y eso abre la puerta.
  -- Dos usos: el primero para retirar, el segundo para devolver.
  codigo            TEXT,
  codigo_usos       INTEGER NOT NULL DEFAULT 0,
  codigo_max_usos   INTEGER NOT NULL DEFAULT 2,
  codigo_expira     TEXT,
  codigo_ultimo_uso TEXT,

  CHECK (cantidad_devuelta >= 0 AND cantidad_devuelta <= cantidad),
  CHECK (codigo_usos >= 0 AND codigo_usos <= codigo_max_usos)
);

-- Un codigo tiene que ser unico entre los VIGENTES del mismo casillero.
-- Puede repetirse en otro casillero (el QR distingue) o mas adelante en el
-- tiempo: por eso el indice es parcial y no un UNIQUE a secas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_codigo_vigente
  ON prestamos (casillero_id, codigo)
  WHERE codigo IS NOT NULL AND estado IN ('aprobado', 'activo');

CREATE INDEX IF NOT EXISTS idx_prestamos_activos  ON prestamos (casillero_id, estado);
CREATE INDEX IF NOT EXISTS idx_prestamos_usuario  ON prestamos (usuario_id, estado);
CREATE INDEX IF NOT EXISTS idx_prestamos_fecha    ON prestamos (solicitado_en DESC);
-- La cola de aprobacion se consulta todo el tiempo desde el panel.
CREATE INDEX IF NOT EXISTS idx_prestamos_pendientes ON prestamos (estado, solicitado_en)
  WHERE estado = 'pendiente';

-- ---------- Cola de ordenes hacia los nodos ----------
-- Un retiro y una devolucion generan EXACTAMENTE el mismo comando fisico
-- (pulsar el solenoide). El campo motivo existe solo para la bitacora.
CREATE TABLE IF NOT EXISTS comandos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  casillero_id   INTEGER NOT NULL REFERENCES casilleros(id),
  prestamo_id    INTEGER REFERENCES prestamos(id),
  tipo           TEXT    NOT NULL,            -- 'ABRIR' | 'PING'
  -- RETIRO | DEVOLUCION | EMERGENCIA | REPOSICION
  -- Un comando de RETIRO solo existe si Alumnado APROBO la solicitud: la
  -- cerradura nunca se acciona por un pedido sin aprobar.
  motivo         TEXT    NOT NULL DEFAULT 'RETIRO',
  origen         TEXT    NOT NULL,            -- 'usuario' | 'admin' | 'sistema'
  solicitado_por TEXT,
  estado         TEXT    NOT NULL DEFAULT 'pendiente', -- pendiente|enviado|confirmado|fallido
  intentos       INTEGER NOT NULL DEFAULT 0,
  creado_en      TEXT    NOT NULL,
  enviado_en     TEXT,
  confirmado_en  TEXT,
  detalle        TEXT
);

CREATE INDEX IF NOT EXISTS idx_comandos_pendientes ON comandos (estado, creado_en);

-- ---------- Intentos de apertura con codigo ----------
-- Cuatro digitos son 10.000 combinaciones: sin limite de intentos se rompen
-- a fuerza bruta en minutos. Esta tabla es lo que permite bloquear un
-- casillero despues de N fallos seguidos, y ademas deja registro del ataque.
CREATE TABLE IF NOT EXISTS intentos_apertura (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  casillero_id INTEGER REFERENCES casilleros(id),
  exito        INTEGER NOT NULL,
  motivo       TEXT,              -- por que fallo (nunca guarda el codigo probado)
  origen       TEXT,              -- IP o identificador del cliente
  creado_en    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intentos_recientes
  ON intentos_apertura (casillero_id, creado_en DESC);

-- ---------- Bitacora de auditoria ----------
CREATE TABLE IF NOT EXISTS eventos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  casillero_id INTEGER REFERENCES casilleros(id),
  prestamo_id  INTEGER REFERENCES prestamos(id),
  tipo         TEXT NOT NULL,
  detalle      TEXT,
  actor        TEXT,
  creado_en    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos (creado_en DESC);
