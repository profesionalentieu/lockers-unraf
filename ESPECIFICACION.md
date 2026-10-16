# Especificación Técnica y Funcional del Sistema de Gestión de Pañol Automatizado (Lockers UNRaf)

El presente documento detalla la arquitectura operativa, las reglas de negocio, el ciclo de vida de los préstamos y el protocolo de comunicación entre el software (Frontend/Backend) y el hardware (ESP32 XIAO, cerraduras solenoides y sensores de fin de carrera) del sistema de lockers inteligentes.

---

## 1. Roles de Usuario y Reglas de Negocio

El sistema administra tres perfiles con permisos y restricciones diferenciadas en la base de datos SQLite:

| Rol | Identificación | Límite de Unidades por Pedido | Ventana de Reserva | Regla de Simultaneidad | Requiere Aprobación de Admin |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Alumno** | Legajo + PIN | Máximo **1 unidad** | Solo para el día en curso | Máximo 1 préstamo activo | **Siempre** (100% de las solicitudes) |
| **Docente** | Legajo + PIN | **Ilimitado** (hasta el 100% del stock disponible en el locker) | Hasta **7 días de anticipación** | **1 sola reserva activa a la vez** (se habilita una nueva recién al concretar o cancelar la vigente) | Solo si solicita **> 50% de la capacidad máxima** del ítem |
| **Alumnado (Admin)** | Usuario (`alumnado`) + Clave | Acceso total de gestión | N/A | N/A | N/A (Autoridad de control) |

---

## 2. Gestión del Tiempo y Concurrencia sobre el Inventario

### 2.1. Bloques de Uso y Buffers
* **Duración seleccionable:** Al generar la solicitud, el usuario debe elegir entre **4 bloques de duración cerrada**: `1 hora`, `2 horas`, `3 horas` o `4 horas`.
* **Tolerancia de retiro (Grace Period):** **15 minutos** a partir de la `hora_inicio` pactada.
* **Buffer técnico posdevolución:** **30 minutos** adicionales al finalizar el turno para garantizar margen entre reservas y mitigar demoras leves.
* **Cálculo de bloqueo temporal de las unidades:**
  $$\text{Hora Límite de Devolución} = \text{Hora de Inicio} + \text{Duración Elegida (1, 2, 3 o 4 hs)}$$
  $$\text{Fin del Bloqueo de Stock} = \text{Hora Límite de Devolución} + 30\text{ minutos}$$

### 2.2. Acceso Concurrente por Stock Parcial
* El bloqueo se aplica **sobre las unidades solicitadas y no sobre el locker físico completo**.
* **Ejemplo operativo:** Si el Locker `A-01` posee una capacidad máxima de 25 unidades y el Docente 1 reserva 5 unidades de 15:00 a 18:00 hs (bloqueadas hasta las 18:30 hs por el buffer), las **20 unidades restantes permanecen disponibles** en el sistema. Un segundo usuario puede reservar 3 unidades de ese mismo Locker `A-01` a las 16:00 hs y abrir la compuerta sin conflicto.

---

## 3. Máquina de Estados del Préstamo

```text
                      ┌── (Alumno o >50% Stock) ──> [ PENDIENTE_APROBACION ] ──(Rechazo)──> [ RECHAZADO ]
                      │                                        │
(Nueva Solicitud) ────┤                                   (Aprobado)
                      │                                        ▼
                      └── (Docente <=50% Stock) ──────> [ RESERVADO ] (Genera Código de Apertura)
                                                               │
                                   ┌───────────────────────────┴───────────────────────────┐
                        (Pasan 15 min sin abrir)                              (Escanea QR + Código válido)
                                   ▼                                                       ▼
                        [ CANCELADO_NO_SHOW ]                                         [ EN_USO ]
                        (Libera stock al instante)                                         │
                                                                    ┌──────────────────────┴──────────────────────┐
                                                         (Devuelve en término)                      (Supera Hora Límite)
                                                                    ▼                                             ▼
                                                    ┌───────────────┴───────────────┐                        [ EN_MORA ]
                                           (Docente <=50%)           (Alumno, >50% o Mora)            (Bloquea Legajo + Alerta)
                                                    ▼                               ▼                             │
                                           [ BUFFER_30_MIN ]             [ PENDIENTE_AUDITORIA ] <────────────────┘
                                                    │                               │                  (Cuando devuelve)
                                             (Pasan 30 min)                 (OK de Alumnado)
                                                    ▼                               ▼
                                              [ FINALIZADO ]                  [ FINALIZADO ]
```

---

## 4. Flujo Operativo Paso a Paso

### Fase 1: Solicitud y Reserva (Web de Usuarios `http://IP_SERVIDOR:3000/`)
1. **Autenticación:** El usuario ingresa su **Legajo** y **PIN**. El backend verifica que el legajo no posea sanciones activas (`bloqueado = false`) ni reservas pendientes (en caso de docentes, valida que no tenga otra reserva futura activa).
2. **Selección de Material y Horario:**
   * Selecciona el ítem deseado y la cantidad (Alumno: fijado en `1`; Docente: `1` hasta `stock_disponible_en_franja`).
   * Selecciona la **Fecha** (Alumno: hoy; Docente: entre hoy y `+7 días`).
   * Selecciona la **Hora de Inicio** (ej. `15:00 hs`) y la **Duración** (`1h`, `2h`, `3h` o `4h`).
3. **Validación de Disponibilidad:** El backend comprueba que en toda la ventana `[hora_inicio, hora_inicio + duracion + 30 min]` la suma de unidades reservadas para ese locker no supere el stock físico disponible.
4. **Evaluación de Aprobación:**
   * **Ruta Automática:** Si el rol es `Docente` y `cantidad_solicitada <= (capacidad_maxima / 2)`, el pedido pasa directo a estado **`RESERVADO`**.
   * **Ruta Administrada:** Si el rol es `Alumno` o un `Docente` solicita `> 50%` de la capacidad máxima, el pedido queda en **`PENDIENTE_APROBACION`** y emite una notificación por WebSocket (`/ws`) hacia el panel de Mesa de Alumnado (`/admin`).
5. **Generación de Credencial de Acceso:** Una vez en estado **`RESERVADO`**, el sistema genera un **Código Único de Operación** (alfanumérico o numérico de 6 dígitos) y lo muestra en la pantalla del usuario junto con el número de locker asignado (ej. `A-01`).

---

### Fase 2: Retiro Físico Frente al Locker (QR + Hardware ESP32 XIAO)

#### Escenario A: El usuario se presenta en término (ej. entre 15:00 y 15:15 hs)
1. **Escaneo de QR Físico:** Cada puerta de locker cuenta con un código QR impreso fijo que redirige a la URL de acceso rápido de ese compartimento (ej. `http://IP_SERVIDOR:3000/locker/A-01`).
2. **Validación de Código y Trazabilidad:**
   * El usuario introduce su **Código de Operación** asignado en la reserva.
   * El backend valida que el código corresponda a ese locker, que esté dentro de la ventana de retiro (`hora_inicio` a `hora_inicio + 15 min`) y registra en el log de auditoría: `legajo`, `locker_id`, `timestamp_intento` y `accion: 'RETIRO'`.
3. **Accionamiento Electrónico (Pulso de 15 segundos):**
   * El backend envía la trama al **ESP32 XIAO** para que energice el solenoide del locker correspondiente.
   * El solenoide se mantiene energizado destrabando la cerradura durante exactamente **15 segundos** y luego corta la energía para proteger la bobina.
4. **Verificación de Apertura Física (Switch Fin de Carrera):**
   * **Si el usuario abre la puerta dentro de los 15 s:** El switch cambia a estado `ABIERTO`. La interfaz web actualiza su estado en vivo vía WebSocket mostrando la animación de puerta abierta.
   * **Si pasan los 15 s y el switch NUNCA se abrió (Fallo de apertura / Puerta trabada):** El préstamo **no** pasa a `EN_USO`. La pantalla del usuario habilita el botón **"Reintentar Apertura"** para enviar un nuevo pulso de 15 s sin penalizar la reserva.
5. **Inspección Visual y Botón de Reporte de Faltantes:**
   * Al abrir el compartimento, el usuario retira únicamente la cantidad de unidades solicitadas.
   * **Flujo de Excepción (Faltante o Daño previo):** Si al abrir el locker el usuario nota que físicamente hay menos unidades de las que debería haber o que el equipo está dañado, presiona en su teléfono el botón **"Reportar Faltante/Incidencia"**.
   * El sistema registra el incidente, cruza en la base de datos quién fue el **último legajo que cerró ese locker previamente**, y envía una alerta crítica al panel `/admin` señalando al presunto responsable para su sanción.
6. **Cierre de Puerta y Alerta de Puerta Abierta:**
   * El usuario empuja la puerta para cerrarla. El switch detecta el estado `CERRADO` y el préstamo cambia a estado **`EN_USO`**.
   * **Seguridad de puerta mal cerrada:** Si transcurren **45 segundos** desde la apertura y el switch sigue reportando `ABIERTO`, el backend dispara una alerta visual y sonora en el celular del usuario y en el panel `/admin`: *"¡Atención! Puerta del Locker A-01 mal cerrada. Por favor presione la puerta hasta escuchar la traba"*.

#### Escenario B: El usuario no se presenta (No-Show a las 15:16 hs)
1. Un proceso programado en el servidor (`Watchdog` activo cada 5000 ms en el backend) verifica las reservas cuyo tiempo supere `hora_inicio + 15 minutos`.
2. Si el estado sigue siendo `RESERVADO` (nunca se abrió), cambia automáticamente a **`CANCELADO_NO_SHOW`**.
3. El Código de Operación queda invalidado, las unidades se liberan de inmediato para que otro docente o alumno pueda pedirlas, y el docente original queda habilitado (o apercibido según reglamento) para realizar una nueva reserva.

---

### Fase 3: Devolución del Material y Auditoría Híbrida

#### 3.1. Proceso Físico de Devolución
1. Antes de que se cumpla la `hora_limite` (ej. `18:00 hs`), el usuario se acerca al locker y escanea nuevamente el **QR fijo de la puerta**.
2. Ingresa su **Código de Operación** (o selecciona **"Iniciar Devolución"** desde su sesión activa).
3. El backend valida la petición, guarda el registro de trazabilidad (`accion: 'DEVOLUCION'`, `timestamp`) y ordena al **ESP32 XIAO** energizar el solenoide durante **15 segundos**.
4. Si la puerta no se abre en esos 15 s, permite **"Reintentar Apertura"**.
5. El usuario abre la puerta, deposita las unidades y cierra el compartimento (con la misma vigilancia de alerta si queda abierta más de 45 segundos).

#### 3.2. Clasificación Post-Cierre (El Modelo Híbrido)
Una vez que el switch confirma el estado `CERRADO`, el backend evalúa las condiciones del préstamo:

* **Camino A — Devolución Estándar (Liberación Automática):**
  * **Condición:** Rol `Docente`, cantidad devuelta `<= 50%` de la capacidad máxima del locker y devuelto **en término** (antes de la `hora_limite`).
  * **Acción:** El préstamo pasa a **`FINALIZADO`** para el docente (ya puede hacer otra reserva para la semana). Las unidades entran en el estado **`BUFFER_30_MIN`** y, cumplidos los 30 minutos, quedan automáticamente disponibles para el turno siguiente (ej. el de las 19:00 hs) sin requerir intervención de Alumnado.

* **Camino B — Devolución Crítica (Requiere Auditoría de Alumnado):**
  * **Condición:** Rol `Alumno`, o cantidad `> 50%` de la capacidad del locker, o devolución realizada **en mora** (después de la `hora_limite`).
  * **Acción:** El préstamo del usuario pasa a **`PENDIENTE_AUDITORIA`** (detiene el reloj de mora del usuario), pero las unidades **no se suman al stock disponible**. En el panel `/admin` aparece una alerta amarilla: *"Verificar reingreso físico en Locker A-01"*. Recién cuando el personal de Alumnado revisa el casillero y presiona **"Confirmar Stock OK"**, las unidades vuelven a estar disponibles.

---

### Fase 4: Gestión de Mora e Incumplimiento (Si no devuelve a término)

Si el reloj alcanza la `hora_limite` (ej. `18:01 hs`) y el préstamo sigue en estado `EN_USO`:

1. **Cambio de Estado y Sanción Automática:**
   * El préstamo pasa a estado **`EN_MORA`**.
   * El usuario recibe en su cuenta el atributo `sancionado = true`, bloqueando la creación de nuevas reservas hasta que Alumnado rehabilite su legajo.
2. **Alerta en Tiempo Real en Mesa de Alumnado (`/admin`):**
   * Se destaca la fila en rojo crítico indicando el legajo, nombre del responsable, unidades retenidas y minutos de demora.
3. **Mitigación para el Turno Siguiente (ej. Reserva de las 19:00 hs):**
   * Si a los 15 minutos previos del siguiente turno (18:45 hs) la devolución no se concretó y el stock libre del locker no alcanza para cubrir el pedido de las 19:00 hs:
     1. El backend verifica si existe otro locker que contenga el mismo tipo de material con stock libre y **reasigna automáticamente** el pedido de las 19:00 hs al nuevo casillero, actualizando el código en la pantalla del segundo docente.
     2. Si no existe stock en otro casillero, envía un aviso en pantalla al docente de las 19:00 hs y a la Mesa de Alumnado para que se le entregue material de respaldo de forma presencial en ventanilla.

---

## 5. Estructura de Base de Datos Propuesta (SQLite)

Para soportar este flujo completo en `backend/data/lockers.db`, el esquema relacional se compone de 4 tablas centrales:

```sql
-- 1. Usuarios y estado disciplinario
CREATE TABLE usuarios (
    legajo TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    rol TEXT CHECK(rol IN ('alumno', 'docente', 'admin')) NOT NULL,
    pin_hash TEXT NOT NULL,
    sancionado INTEGER DEFAULT 0, -- 0: Activo, 1: Bloqueado por mora o faltante
    motivo_sancion TEXT
);

-- 2. Lockers e inventario físico
CREATE TABLE lockers (
    id TEXT PRIMARY KEY,          -- Ej: 'A-01', 'A-02'
    descripcion_item TEXT NOT NULL,
    capacidad_maxima INTEGER NOT NULL,
    stock_actual_fisico INTEGER NOT NULL,
    estado_puerta TEXT CHECK(estado_puerta IN ('CERRADO', 'ABIERTO')) DEFAULT 'CERRADO'
);

-- 3. Préstamos y reservas por franja horaria
CREATE TABLE prestamos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legajo_usuario TEXT NOT NULL,
    locker_id TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    codigo_operacion TEXT UNIQUE NOT NULL, -- Código de 6 dígitos para abrir tras escanear QR
    fecha_reserva DATE NOT NULL,
    hora_inicio TIME NOT NULL,
    duracion_horas INTEGER CHECK(duracion_horas IN (1, 2, 3, 4)) NOT NULL,
    hora_limite TIME NOT NULL,             -- hora_inicio + duracion_horas
    hora_fin_buffer TIME NOT NULL,         -- hora_limite + 30 min
    estado TEXT CHECK(estado IN (
        'PENDIENTE_APROBACION',
        'RECHAZADO',
        'RESERVADO',
        'CANCELADO_NO_SHOW',
        'EN_USO',
        'EN_MORA',
        'BUFFER_30_MIN',
        'PENDIENTE_AUDITORIA',
        'FINALIZADO'
    )) NOT NULL,
    timestamp_retiro DATETIME,
    timestamp_devolucion DATETIME,
    FOREIGN KEY (legajo_usuario) REFERENCES usuarios(legajo),
    FOREIGN KEY (locker_id) REFERENCES lockers(id)
);

-- 4. Trazabilidad de aperturas y reportes de faltantes
CREATE TABLE logs_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    locker_id TEXT NOT NULL,
    legajo_usuario TEXT NOT NULL,
    prestamo_id INTEGER,
    evento TEXT CHECK(evento IN (
        'PULSO_APERTURA_RETIRO',
        'PUERTA_ABIERTA',
        'PUERTA_CERRADA',
        'REINTENTO_APERTURA',
        'ALERTA_PUERTA_ABIERTA',
        'PULSO_APERTURA_DEVOLUCION',
        'REPORTE_FALTANTE_O_DANO'
    )) NOT NULL,
    detalle_reporte TEXT,
    ultimo_responsable_previo TEXT, -- Autocompletado al reportar un faltante
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```