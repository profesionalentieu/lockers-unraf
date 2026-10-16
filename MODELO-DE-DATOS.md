# Modelo de datos — Lockers UNRaf (v3)

Este documento explica cómo el esquema (`backend/src/db/schema.sql`, versión 4) implementa la
especificación (`ESPECIFICACION.md`) y por qué se tomó cada decisión.

## 1. Las tablas

Las **cuatro tablas centrales** son las de la especificación, con los mismos nombres, columnas y
`CHECK`: `usuarios`, `lockers`, `prestamos` y `logs_auditoria`. Se suman tres de apoyo:

| Tabla | Para qué |
|---|---|
| `nodos` | La placa ESP32 de cada gabinete (RSSI, último contacto). |
| `comandos` | Cola de órdenes hacia la radio, con la duración del pulso (`duracion_ms = 15000`). |
| `eventos` | Bitácora de **negocio** (aprobaciones, no-show, mora, sanciones, auditorías, reasignaciones). `logs_auditoria` queda para lo **físico**. |

```
usuarios (legajo PK) 1 ──── N prestamos N ──── 1 lockers (id 'A-01' PK) N ──── 1 nodos
                                  │                    │
                                  └──── N logs_auditoria (trazabilidad física)
                                                       └──── N comandos (cola hacia la radio)
```

## 2. Qué se agregó a las tablas de la especificación y por qué

Todo lo agregado está marcado `EXTENSION` en `schema.sql`. Nada de la spec se sacó ni se renombró.

**`usuarios`**
- `activo`: baja lógica. Borrar a alguien rompería la trazabilidad de sus préstamos.
- `sancionado_en`: cuándo empezó la sanción.
- La cuenta de Alumnado vive en la misma tabla (`legajo = 'alumnado'`, `rol = 'admin'`, clave en
  `pin_hash`), como sugiere el `CHECK (rol IN ('alumno','docente','admin'))` de la spec.

**`lockers`**
- `categoria`, `nodo_id`, `bit_registro`: presentación y a qué salida del ESP32 está cableada la puerta.
- `estado_operativo`, `detalle_error`: el watchdog marca ERROR una puerta abierta más de 120 s.
- `abierta_desde`, `alerta_puerta_enviada`: para la alerta de los 45 s (una por apertura).
- `op_*`: **la operación física en curso** (ver sección 5).

**`prestamos`**
- `inicio_ts`, `limite_ts`, `fin_buffer_ts`: la misma franja que `fecha_reserva` + `hora_*`, pero
  como instantes UTC. Las columnas de la spec guardan la hora **local** para mostrar ("15:00"); las
  `_ts` son las que se comparan. Así una consulta no depende de la zona horaria del servidor.
- `descripcion_item`: foto del material al reservar. Si Alumnado cambia lo que guarda un locker,
  el historial sigue diciendo la verdad.
- `requiere_aprobacion`, `resuelto_por/en`, `motivo_rechazo`: quién decidió qué.
- `intentos_apertura`: si la persona pidió al menos un pulso **no es un no-show**, aunque la puerta
  no haya abierto (spec 2.4: reintentar "sin penalizar la reserva").
- `devolucion_en_termino`, `camino_devolucion` ('A' / 'B'), `mora_desde`, `auditado_*`,
  `unidades_recibidas`: el resultado del modelo híbrido y de la auditoría.
- `locker_original_id`, `requiere_respaldo`, `entregado_en_ventanilla`: la mitigación de la Fase 4.3.
- Estado **`CANCELADO`** (el único estado nuevo): la spec dice que el docente habilita una nueva
  reserva "al concretar **o cancelar** la vigente", así que hace falta poder cancelar.

**`logs_auditoria`**
- `revisado`: Alumnado marca un reporte de faltante como resuelto y deja de verlo en alertas.
- `legajo_usuario` es `NOT NULL` en la spec. Lo que pasa sin una persona detrás (una puerta que se
  abre sin apertura autorizada) se firma `'sistema'`; las aperturas de emergencia, `'alumnado'`.

## 3. La decisión central: el stock por franja no se guarda, se deriva

La spec pide que el bloqueo sea **sobre las unidades y no sobre el locker** (2.2). No existe
ninguna columna "disponible". `stock_actual_fisico` es cuántas unidades **pertenecen** al locker y
están en servicio (adentro o prestadas), y lo que se puede reservar en una franja se calcula:

```
disponible(franja) = stock_actual_fisico − pico de unidades bloqueadas dentro de la franja
```

Cada préstamo bloquea sus unidades durante un intervalo que depende de su estado:

| Estado | Bloquea | Por qué |
|---|---|---|
| `PENDIENTE_APROBACION`, `RESERVADO`, `EN_USO` | `[inicio, límite + 30 min)` | La franja más el buffer técnico (spec 2.1). |
| `BUFFER_30_MIN` | `[inicio, devolución + 30 min)` | Si devolvió antes, libera antes. |
| `EN_MORA` | `[inicio, …)` sin fin | Las unidades no volvieron: no se pueden prometer. |
| `PENDIENTE_AUDITORIA` | `[inicio, …)` hasta el OK | "Las unidades **no se suman** al stock disponible" (spec 3.2-B). |
| el resto | nada | |

**Pico, no suma.** Si la franja pedida se superpone con dos reservas que no se superponen entre
sí, no compiten por las mismas unidades. Se calcula el máximo de unidades bloqueadas al mismo
tiempo (barrido sobre el inicio de la franja y los inicios de cada intervalo adentro de ella).

Con el ejemplo de la spec: A-01 con 25, el Docente 1 reserva 5 de 15:00 a 18:00 (bloqueadas hasta
18:30). Para 16:00–17:30 el pico es 5 → quedan 20; un segundo usuario reserva 3 sin conflicto. Está
probado tal cual en `test/escenarios.test.js`.

**La solicitud pendiente también bloquea.** Si no lo hiciera, dos personas podrían pedir las
últimas unidades de la misma franja y Alumnado aprobaría las dos. La contracara —una solicitud que
nadie resuelve bloquea material— la cierra el watchdog: se rechaza sola cuando vence la tolerancia.

**La condición de carrera.** Validar y escribir van en la **misma transacción**
(`prestamo.service.js`, `solicitar`): dos pedidos simultáneos por las últimas unidades no pueden
pasar los dos la validación.

## 4. La máquina de estados y quién mueve cada transición

| Transición | La dispara |
|---|---|
| nueva → `PENDIENTE_APROBACION` / `RESERVADO` | la persona (según rol y 50%) |
| `PENDIENTE_APROBACION` → `RESERVADO` / `RECHAZADO` | Alumnado (o el watchdog si vence la tolerancia) |
| `RESERVADO` → `CANCELADO_NO_SHOW` | watchdog, 15 min después del inicio sin ningún pulso pedido |
| `RESERVADO` → `CANCELADO` | la persona o Alumnado; el watchdog si hubo intentos pero la puerta nunca abrió en toda la franja |
| `RESERVADO` → `EN_USO` | **el microswitch**: CERRADO después de un ABIERTO en una operación de retiro |
| `EN_USO` → `EN_MORA` | watchdog en la hora límite (+ sanción automática) |
| `EN_USO` / `EN_MORA` → `BUFFER_30_MIN` / `PENDIENTE_AUDITORIA` | **el microswitch** al cerrar una devolución (modelo híbrido) |
| `BUFFER_30_MIN` → `FINALIZADO` | watchdog, 30 min después de la devolución |
| `PENDIENTE_AUDITORIA` → `FINALIZADO` | Alumnado: "Confirmar Stock OK" |

El watchdog corre cada **5000 ms** (spec, escenario B).

**"En término" se decide al validar el código, no al cerrar.** Si alguien empieza a devolver a las
17:59 y la puerta cierra a las 18:01, devolvió a tiempo: la operación guarda `op_en_termino` en el
momento del pulso, y el watchdog no lo pasa a mora mientras su devolución está en curso.

## 5. La operación física (columnas `op_*` de `lockers`)

Varios préstamos comparten un locker, pero la puerta y el microswitch son uno solo. Cuando alguien
valida su código, el locker queda **tomado por esa operación** hasta que la puerta se cierra:

- El ABIERTO/CERRADO del switch se **atribuye** a esa persona en `logs_auditoria`. Es lo que
  permite responder "¿quién fue el último que cerró este locker?" cuando otro reporta un faltante.
- Si otra persona valida su código mientras tanto, recibe "el locker está siendo usado, esperá a
  que cierre la puerta". Son segundos.
- Una operación que nunca abrió la puerta se abandona a los 120 s (`OPERACION_ABANDONO_SEG`) para
  no dejar el locker tomado; la reserva sigue y se puede reintentar.

## 6. El código de operación

- 6 dígitos al azar (`crypto.randomInt`), `UNIQUE` como pide la spec.
- Se genera al crear la reserva (la columna es `NOT NULL`), pero **solo se muestra** en `RESERVADO`,
  `EN_USO` y `EN_MORA`. Una solicitud pendiente no tiene código visible.
- Es la credencial frente a la puerta: la pantalla del QR no pide legajo ni PIN. Por eso hay un
  límite de códigos incorrectos por IP (8 cada 5 min) y el código solo sirve **en su locker** y
  **dentro de su ventana**. Al validar, la pantalla recibe un token corto (20 min) atado a ese
  préstamo y ese locker, que es lo que permite *Reintentar* y *Reportar faltante*.
- En una reasignación (Fase 4.3) se genera un código nuevo: el viejo deja de servir.

## 7. Lo que este modelo no puede saber

El sistema registra **lo que la persona declaró**, no lo que efectivamente sacó. El microswitch dice
que la puerta se abrió y se cerró, nada más. Lo que esta versión agrega para acotar la brecha:

1. **Reporte de faltante con presunto responsable**, cruzado con la trazabilidad física.
2. **Auditoría obligatoria** en las devoluciones críticas, con descuento del stock físico si falta algo.

Lo que la cerraría del todo: sensor de peso (ítems homogéneos) o RFID por unidad.
