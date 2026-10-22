# Contrato firmware ↔ servidor

Este archivo es el acuerdo entre el software del servidor y el firmware de las placas ESP32
(XIAO ESP32S3 y ESP32-C3 SuperMini, en ESP-IDF: ver [`README.md`](README.md)).
Mientras el firmware respete esto, backend y hardware se pueden desarrollar en paralelo.

> **La radio es intercambiable.** El proyecto empezó con LoRa (SX1262) y pasó a ESP-NOW, y ni el
> backend ni el puente serie cambiaron una línea: el protocolo es el mismo. Esa independencia es
> deliberada, y vale la pena señalarla en el informe — el servidor nunca supo qué radio había del
> otro lado.

## Identificación

| Concepto | Significado en el firmware |
|---|---|
| `nodo` | Código del gabinete, fijo en el firmware (`"NODO-A"`). Uno por placa. |
| `bit` | Índice de la salida del **SN74HC595** que dispara el gate del **IRLZ44N** de esa puerta (0…7). |
| `casillero` | Solo etiqueta para humanos (`"A-01"`). El firmware no la necesita. |

En el prototipo: `A-01 → bit 0`, `A-02 → bit 1`, `A-03 → bit 2`, `A-04 → bit 3`, todos en `NODO-A`.

## Direccionamiento en ESP-NOW

Las tramas van por **difusión** (`FF:FF:FF:FF:FF:FF`) en los dos sentidos, y cada placa filtra por
el campo `nodo`. Esto evita tener que grabar la MAC del gateway en cada nodo y viceversa: las
placas se pueden intercambiar sin tocar el código.

La contra es que la difusión no tiene confirmación a nivel de enlace. No importa: la confiabilidad
la da el ACK de aplicación con reintentos que ya maneja el backend, exactamente igual que cuando
la radio era LoRa.

**Las dos placas tienen que estar en el mismo canal WiFi** (`CANAL 1` en el firmware). Si difieren,
las dos arrancan sin error y simplemente no se ven: es la falla número uno.

## Tramas que recibe el nodo

```json
{"id": 12, "nodo": "NODO-A", "bit": 0, "accion": "ABRIR", "ms": 15000, "motivo": "RETIRO"}
```

> `ms` es **cuánto tiempo energizar el solenoide**: 15 000 por especificación (es la ventana que tiene
> la persona para tirar de la puerta). Lo decide el backend (`PULSO_APERTURA_SEG`), no el firmware.
> Si una trama vieja no lo trae, el nodo usa 15 000; nunca acepta más de 20 000.
>
> `motivo` (RETIRO / DEVOLUCION / EMERGENCIA) viaja solo para los logs.
> **El firmware lo ignora**: sacar material y guardarlo son la misma acción física.

Al recibirla, el nodo debe:

1. Energizar la salida de esa puerta (bit del SN74HC595 en la placa ESP-NOW, GPIO directo en la
   placa WiFi) y **responder el ACK con el mismo `id` apenas arranca el pulso**.
2. Mantenerla energizada `ms` milisegundos **sin bloquear**: durante esos 15 s el nodo tiene que
   seguir leyendo los microswitches (el backend necesita el ABIERTO en el acto) y atender otras
   puertas. Cada salida guarda su "hasta cuándo" y la tarea de `componentes/puertas` apaga la
   que venció.
3. Volver la salida a cero al terminar — el solenoide no debe quedar energizado o se quema.
4. Cuidar la fuente: como máximo `MAX_SIMULTANEOS` (2) bobinas a la vez y arranques separados por
   300 ms. Una orden que no entra espera turno y su ACK sale cuando arranca.
5. Si llega una orden para una puerta que **ya** está energizada (un reintento del backend porque se
   perdió el ACK), extender el pulso y volver a confirmar: no es un error.

> El accionamiento **no** se hace dentro del callback de recepción: ESP-NOW lo llama desde la tarea
> de WiFi. El callback copia la trama a una cola (`componentes/enlace_espnow`) y la tarea del nodo la
> procesa.

> Opción `CORTAR_AL_ABRIR` (por defecto `false`, para respetar los 15 s de la especificación): si la
> bobina calienta demasiado en las pruebas, en `true` corta apenas el switch confirma la apertura.

> Nota de diseño: el `id` viaja de ida y vuelta para que el servidor pueda distinguir un ACK real
> de un eco tardío. Sin él, un reintento confirmaría el comando equivocado.

## Tramas que emite el nodo

```json
{"tipo":"ack","id":12,"ok":true,"rssi":-52}
{"tipo":"telemetria","nodo":"NODO-A","lecturas":[{"bit":0,"puertaAbierta":true}],"rssi":-52}
{"tipo":"heartbeat","nodo":"NODO-A","rssi":-52,"bateriaMv":4020}
```

- **telemetría**: enviar en cada *cambio* del microswitch (con antirrebote por software,
  ~50 ms) y además un reporte completo de las 4 puertas cada 60 s. El reporte periódico
  es el que resincroniza el tablero si se perdió una trama de cambio.
- **heartbeat**: cada 60 s. El backend marca el nodo como desconectado a los `NODO_OFFLINE_SEG`
  (180 s por defecto), o sea que tolera dos latidos perdidos antes de encender la alarma.

El `rssi` es el de la última trama recibida. Con ESP-NOW los valores típicos van de −30 dBm
(al lado) a −85 dBm (al límite del alcance).

## Cableado del microswitch

Se usan **COM y NO**, con el switch montado de modo que la puerta cerrada apriete la palanca:

| Situación | Palanca | Contacto C-NO | Lectura del pin | Estado |
|---|---|---|---|---|
| Puerta cerrada | apretada | cerrado | LOW | cerrada |
| Puerta abierta | libre | abierto | HIGH | abierta |

Es a prueba de fallas: un cable cortado deja el circuito abierto y el sistema reporta **abierta**,
que es el estado seguro. No confíes en la posición de los terminales: en algunos modelos el del
medio no es el COM.

## Por qué el servidor nunca asume que la puerta se abrió

El ACK confirma que el nodo **energizó el solenoide**, no que la puerta se abrió.
El estado de la puerta sale exclusivamente del microswitch, y con él se mueve el préstamo:

| Lo que reporta el switch | Durante un retiro | Durante una devolución |
|---|---|---|
| ABIERTO | "Retirá N unidades" + reportar faltante | "Depositá N unidades" |
| CERRADO (después de un ABIERTO) | `RESERVADO` → `EN_USO` | → `BUFFER_30_MIN` o `PENDIENTE_AUDITORIA` |
| nada en 15 s | "Reintentar apertura" (sin penalizar) | "Reintentar apertura" |
| ABIERTO más de 45 s | alerta de puerta mal cerrada | ídem |
| ABIERTO más de 120 s | el locker pasa a ERROR | ídem |
| ABIERTO sin que nadie haya validado un código | alerta crítica "apertura no autorizada" | |

Por eso **cada cambio** del switch tiene que llegar, y el reporte completo cada 60 s existe para
resincronizar si se perdió alguno.
