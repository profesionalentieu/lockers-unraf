# Contrato firmware ↔ servidor

Este archivo es el acuerdo entre el software del servidor y el firmware de las XIAO ESP32S3.
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
{"id": 12, "nodo": "NODO-A", "bit": 0, "accion": "ABRIR", "motivo": "RETIRO"}
```

> `motivo` (RETIRO / DEVOLUCION / EMERGENCIA) viaja solo para los logs del gateway.
> **El firmware lo ignora**: sacar material y guardarlo producen exactamente la misma
> acción física. Si el nodo hiciera algo distinto según el motivo, sería un bug.

Al recibirla, el nodo debe:

1. Cargar el registro con solo ese bit en alto (`shiftOut` + pulso a `RCLK`).
2. Mantener la salida activa el tiempo de pulso del solenoide. **Medido en banco: la cerradura
   suelta desde 100 ms; el firmware usa 150 ms para tener 50 % de margen.**
3. Volver el registro a cero — el solenoide no debe quedar energizado o se calienta y se quema.
4. Responder el ACK con el mismo `id`.

> El accionamiento **no** se hace dentro del callback de recepción: ESP-NOW lo llama desde el
> contexto de WiFi y un `delay()` de 150 ms ahí adentro es una mala idea. El callback deja el
> pedido marcado y el `loop()` lo ejecuta.

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

El ACK confirma que el nodo **accionó la cerradura**, no que la puerta se abrió.
El estado `PUERTA_ABIERTA` del tablero sale exclusivamente del microswitch.
Si hay ACK pero nunca llega telemetría de apertura, el caso más probable es un solenoide
trabado: ese es justamente el escenario que detecta Alumnado en el dashboard.
