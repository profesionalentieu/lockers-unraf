# Puesta en marcha — de la demo al sistema real

Cinco etapas. Cada una funciona sola y agrega una pieza, así siempre sabés qué rompiste.
Las tres primeras no necesitan una sola placa.

---

## Etapa 1 — El backend real en una PC (30 minutos)

Ya está todo escrito; hay que instalarlo.

```bash
cd backend
cp .env.example .env      # Windows: copy .env.example .env
npm install
npm run seed
npm start
```

Abrí `http://localhost:3000/admin` (alumnado / unraf2025) y `http://localhost:3000/` (docente 20011,
PIN 1145). Reservá 5 notebooks para la hora actual y mirá cómo el gabinete las marca como reservadas.
`npm test` recorre los 22 escenarios de la especificación con el reloj adelantado.

**Ya no es una demo**: los datos se guardan en `backend/data/lockers.db`, sobreviven al reinicio y
el WebSocket sincroniza las dos pantallas. Lo único que falta es que se abra una puerta de verdad.

**Si algo falla acá**, es casi siempre una de estas tres:

| Síntoma | Causa |
|---|---|
| `node-gyp` falla en `npm install` | Faltan las build tools. En Windows: instalar Visual Studio Build Tools. |
| `SQLITE_ERROR: no such table` | Falta correr `npm run seed`. |
| "La base de datos es de una versión anterior" | Base de la v2 (esquema v3). Borrá la carpeta `backend/data` y volvé a sembrar. |

---

## Etapa 2 — Los celulares contra el servidor (10 minutos)

Hasta acá todo corre en `localhost`, que desde el celular no existe. Necesitás la IP de la PC en la
red de la facultad:

- Windows: `ipconfig` → "Dirección IPv4", algo como `192.168.0.15`
- Mac / Linux: `ip addr` o `ifconfig`

Desde el celular, conectado **al mismo WiFi**, abrí `http://192.168.0.15:3000`. El frontend usa
`location.origin`, así que se conecta solo a la API sin tocar nada.

Ahora imprimí los QR: Alumnado → *Imprimir los QR de las puertas*, con la IP (no `localhost`) en el
campo de arriba. Cada QR abre `http://192.168.0.15:3000/locker/A-0X`, la pantalla donde se ingresa
el código. Si la IP de la PC cambia, hay que reimprimirlos: conviene fijarla en el router o poner
`URL_PUBLICA` en `.env`.

Si no carga, el firewall de la PC está bloqueando el puerto 3000: en Windows, "Permitir una
aplicación a través del Firewall" → Node.js, red privada.

**Esto es lo que hay que probar antes de la demostración.** El día de la defensa, la PC y el
celular tienen que estar en la misma red, y conviene tener la IP anotada en un papel.

---

## Etapa 3 — El circuito completo sin hardware (5 minutos)

Acá está la pieza que vuelve el proyecto demostrable aunque las placas no estén listas.

Con el backend corriendo, en **otra terminal**:

```bash
node gateway/simulador_nodo.js
```

El simulador hace de gateway, de nodo y de persona: toma la orden, "energiza" el solenoide los 15 s
que pide, manda el ACK, "abre" la puerta a los 2-5 s y la cierra unos segundos después. Validá un
código en `/locker/A-01` y vas a ver la cuenta regresiva, la puerta abierta y el retiro registrado.

Los escenarios que conviene ensayar, porque son las preguntas que va a hacer la cátedra:

```bash
node gateway/simulador_nodo.js --no-abre A-02
# nadie abre la puerta -> a los 15 s "Reintentar apertura", sin perder la reserva

node gateway/simulador_nodo.js --cierre 50
# la puerta queda abierta 50 s -> alerta de puerta mal cerrada a los 45 s

node gateway/simulador_nodo.js --trabar A-03
# esa puerta nunca cierra -> alerta a los 45 s y ERROR a los 120 s

node gateway/simulador_nodo.js --perder 30
# se pierde el 30% de las órdenes -> se ven los reintentos automáticos
```

Cuando el hardware esté listo, se apaga el simulador y se prende `gateway_serie.py`. El backend no
se entera de la diferencia: habla el mismo protocolo con los dos.

---

## Etapa 4 — El hardware (el trabajo de Bertola)

> El procedimiento completo, con conexionado, mediciones y tabla de fallas, está en
> **`HARDWARE.md`**. Acá va solo el resumen del orden.
>
> El firmware es **ESP-IDF 6.1** y se graba desde **VS Code** con la extensión de Espressif: cómo
> instalarlo y usarlo está en **`firmware/README.md`**. "Cargar" un proyecto, acá, es abrirlo en
> `firmware/lockers.code-workspace`, elegirlo como proyecto activo y hacer *Build, Flash and Monitor*.

Cuatro pasos, en este orden. Saltearse el primero es la causa número uno de días perdidos.

### 4.1 Confirmar el enlace ESP-NOW, sin nada más conectado

Cargá `firmware/pruebas/prueba_espnow` en las dos placas, una como sonda y otra como eco
(`#define ES_SONDA 1` / `0`). Hasta
que dos placas peladas no se hablen, no tiene sentido sumar registros ni solenoides.

**El problema más probable es el canal.** Las dos tienen que usar el mismo `#define CANAL`; si
difieren, arrancan sin error y no se ven.

Aprovechá esta etapa para medir el alcance real en el edificio: es el dato que decide dónde puede
ir el gateway, y con ESP-NOW es bastante más corto que con LoRa.

### 4.2 Gateway

Cargá `firmware/gateway`. Cerrá el monitor de VS Code (el puerto lo va a usar el script), dejá
la placa conectada por USB a la PC y probá:

```bash
pip install pyserial websocket-client
python gateway/gateway_serie.py --puerto /dev/ttyACM0 --backend http://localhost:3000
```

En Windows el puerto es `COM3`, `COM4`, etc. (Administrador de dispositivos → Puertos).

### 4.3 Nodo, primero en el escritorio

Cargá `firmware/nodo` en la otra placa. Antes de conectar nada de potencia, probalo con un
**LED con su resistencia** en cada salida del SN74HC595: validá un código en `/locker/A-01` y mirá
el LED prenderse **15 segundos** (el pulso de servicio). Es la prueba más barata de que toda la
cadena funciona.

Los microswitches se prueban igual de simple: pull-up interno, un extremo a GND, y en el monitor
(*ESP-IDF: Monitor Device*) tenés que ver `Puerta N -> ABIERTA` al soltarlos.

### 4.4 Potencia

Recién ahora el 12 V. Tres cosas que queman prototipos:

- **Diodo flyback** en paralelo con cada solenoide (1N4007, cátodo al positivo). Un solenoide es una
  bobina: al cortar la corriente genera un pico inverso que se lleva puesto al MOSFET.
- **Masa común** entre la fuente de 12 V y el ESP32. Sin eso el MOSFET no tiene referencia y hace
  cosas impredecibles.
- **Pull-down de 10 k** en cada salida del 595 hacia el gate. Durante el arranque del ESP32 las
  salidas quedan en alta impedancia, y sin el pull-down un solenoide puede dispararse solo al
  energizar el equipo. Es un susto feo en la demostración.

Medí el consumo real del solenoide antes de elegir la fuente: los de 12 V suelen pedir entre 0,5 y
1 A durante el pulso, que ahora dura **15 s**. El firmware permite como máximo 2 bobinas a la vez y
separa los arranques 300 ms justamente por esto (ver `HARDWARE.md`, etapa 5).

---

## Etapa 5 — Que quede prendido (opcional)

Para el prototipo alcanza con dejar la notebook corriendo `npm start`. Si quieren algo permanente:

**Una Raspberry Pi** es la opción natural: consume poco, se deja enchufada en el pañol, y el mismo
gateway USB va conectado ahí. Se instala Node igual, y con `pm2` el servidor levanta solo al
reiniciar:

```bash
npm install -g pm2
pm2 start src/server.js --name panol
pm2 startup && pm2 save
```

**IP fija.** Si la PC cambia de IP, los celulares dejan de encontrarla. Pedile a Sistemas de la
facultad una reserva DHCP por MAC, o configurá IP estática.

**Antes de una instalación real** (no para la entrega, pero sí para el informe): HTTPS, firmar las
tramas de radio con HMAC más contador anti-replay, y reemplazar el PIN por el SSO de la facultad. Están
detallados al final del README.

---

## Orden sugerido de trabajo

| Cuándo | Vos | Bertola |
|---|---|---|
| Esta semana | Etapas 1, 2 y 3 | Etapa 4.1: confirmar el enlace ESP-NOW |
| Próxima | Cargar el catálogo real del pañol y el padrón | 4.2 y 4.3: gateway y nodo con LEDs |
| Después | Ensayar la demostración con el simulador | 4.4: potencia y montaje en el gabinete |

Lo importante es que las etapas 1 a 3 **no dependen del hardware**. Si las placas se atrasan,
igual tienen un sistema funcionando para mostrar, y el simulador hace de nodo mientras tanto.
