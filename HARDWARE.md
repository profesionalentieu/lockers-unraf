# Armado del sistema real — procedimiento de puesta a punto

Guía para pasar del simulador al gabinete funcionando. El orden importa: cada etapa se prueba
sola antes de sumar la siguiente, así cuando algo falla sabés exactamente qué lo rompió.

**La regla que más tiempo ahorra: nunca sumes dos cosas nuevas a la vez.** Si conectás el
registro de desplazamiento y los solenoides en el mismo paso y no anda, tenés dos sospechosos y
ninguna forma barata de distinguirlos.

---

## 0. Antes del viernes (hacelo ahora, son descargas)

Si esto queda para el día que llegan las placas, se les va la mañana bajando paquetes.

1. **Arduino IDE 2.x** desde arduino.cc.
2. **Soporte para ESP32**: Archivo → Preferencias → "URLs adicionales de gestor de tarjetas",
   pegar `https://espressif.github.io/arduino-esp32/package_esp32_index.json`. Después
   Herramientas → Placa → Gestor de tarjetas → buscar "esp32" e instalar el paquete de Espressif.
   Son varios cientos de MB.
3. **Librerías** (Herramientas → Gestionar bibliotecas):
   - `ArduinoJson` de Benoit Blanchon (versión 7). ESP-NOW ya viene con el paquete ESP32.
4. **Placa seleccionada**: Herramientas → Placa → esp32 → **XIAO_ESP32S3**.

### Checklist de componentes

Además de las placas, para el prototipo hacen falta:

| Qué | Cuánto | Para qué |
|---|---|---|
| Resistencias 10 kΩ | 8 | Pull-down en los gates de los MOSFET |
| Resistencias 220–330 Ω | 4 | Para los LEDs de prueba (etapa 3) |
| SN74HC595 | 1 | Expande 3 pines del micro a 8 salidas |
| LEDs comunes | 4 | Probar el registro sin riesgo antes de conectar potencia |
| Diodos 1N4007 | 4 (uno por solenoide) | **Flyback**: sin esto se queman los MOSFET |
| Capacitor electrolítico 470–1000 µF / 25 V | 1 | Absorbe el pico de corriente del pulso |
| Capacitor cerámico 100 nF | 1 por integrado | Desacople de alimentación |
| Fuente 12 V, 2 A mínimo | 1 | Con solenoides de 600 mA y accionando de a uno, 1,5 A alcanza; 2 A da margen para el pico de arranque |
| Multímetro | 1 | Medir consumo real y verificar continuidad |
| Protoboard y jumpers | — | Todo el armado previo al gabinete |

---

## 1. Las placas solas (30 min)

Antes de cablear nada: conectá cada XIAO por USB y cargá el ejemplo **Blink**. Confirma tres
cosas de una: que el cable es de datos y no solo de carga, que el driver anda, y que la placa
entra en modo programación.

> Si la PC no detecta la placa: mantené apretado el botón **BOOT**, conectá el USB, soltá. Eso
> fuerza el modo bootloader. En Windows revisá el Administrador de dispositivos para ver en qué
> COM aparece.

---

## 2. El enlace ESP-NOW, con nada más conectado (1 h, es la etapa crítica)

**No sigas a la etapa 3 hasta que dos placas peladas se hablen.** Sumarle registros y solenoides
a un enlace que no funciona solo agrega variables.

ESP-NOW usa el WiFi que el ESP32-S3 trae adentro, así que **no hace falta ningún módulo de radio
externo**: alcanza con las dos XIAO y sus antenas de 2,4 GHz. Verificá que la antena chica esté
conectada al conector IPEX antes de energizar.

En `firmware/pruebas/` hay dos sketches para esta etapa:

- **`obtener_mac/obtener_mac.ino`** — imprime la MAC de cada placa. El firmware usa difusión y no
  la necesita, pero anotarlas sirve para etiquetar las placas y para diagnosticar.
- **`prueba_espnow/prueba_espnow.ino`** — ping-pong entre las dos, con RTT, RSSI de los dos
  extremos y porcentaje de entrega. Cambiás `#define ES_SONDA` en cada una.

### El canal es la falla número uno

Las dos placas tienen que estar en el **mismo canal WiFi** (`#define CANAL 1`). Si difieren, las
dos arrancan sin dar ningún error y simplemente no se ven. Antes de sospechar del código, revisá
el canal.

Ojo también con la versión del núcleo de Arduino: en la **3.x** el callback de recepción recibe
una estructura con el RSSI; en la **2.x** la firma es distinta y no hay RSSI. Los sketches están
escritos para 3.x.

### La medición que importa

En la mesa el enlace va a funcionar sí o sí. Lo que hay que medir es el **alcance real en el
edificio**, porque a 2,4 GHz el hormigón atenúa mucho: una placa fija donde va a estar el gateway,
la otra caminando, anotando RSSI y porcentaje de entrega a cada distancia. Contra los cientos de
metros de LoRa, esperá entre 20 y 50 metros en un pasillo.

Esa tabla decide dónde puede estar el gateway, y queda muy bien en el informe.

---

## 3. El registro de desplazamiento, con LEDs (1 h)

Ahora sí, el SN74HC595 — pero manejando LEDs, no solenoides. Es la prueba más barata de que toda
la cadena software → radio → firmware → registro funciona.

### Conexionado

| Pin del 595 | Va a |
|---|---|
| 14 (SER / DS) | GPIO de datos del XIAO (`PIN_SR_DATOS`) |
| 11 (SRCLK) | GPIO de reloj (`PIN_SR_RELOJ`) |
| 12 (RCLK / LATCH) | GPIO de latch (`PIN_SR_LATCH`) |
| 10 (SRCLR) | VCC (activo en bajo: si queda suelto, borra el registro) |
| 13 (OE) | GND (ver la nota de abajo) |
| 16 (VCC) y 8 (GND) | Alimentación, con un 100 nF entre ellos |
| Q0–Q3 | LED + resistencia de 330 Ω a GND |

### ⚠ Alimentación del 595: 3,3 V, no 5 V

El ESP32 trabaja a 3,3 V. Si alimentás el 595 a 5 V, su umbral de entrada alta es 0,7 × VCC =
**3,5 V**, o sea que los 3,3 V del ESP32 no alcanzan a garantizar un "1" lógico: puede andar en
el banco de pruebas y fallar de forma intermitente después. Dos salidas correctas:

- **Alimentar el 595 a 3,3 V** (lo más simple). El umbral baja a 2,31 V y el ESP32 lo maneja sin
  problema. La contra: el gate del MOSFET recibe solo 3,3 V.
- **Usar un SN74HCT595 alimentado a 5 V.** La variante **HCT** tiene entradas con niveles TTL
  (umbral 2 V), así que acepta los 3,3 V del ESP32 y entrega 5 V al gate, que es mejor para el
  MOSFET. Si todavía están a tiempo de pedir, esta es la opción más prolija.

El IRLZ44N es de nivel lógico y conmuta con 3,3 V para corrientes de este orden, pero queda menos
holgado. Si van por 3,3 V, **medí la caída entre drain y source con el solenoide activo**: si es
de décimas de volt, está bien; si el MOSFET se calienta, no está saturando y conviene pasar a
HCT a 5 V.

### El arranque

Al energizar, las salidas del 595 quedan en estado indefinido hasta el primer latch. Con OE a
masa eso se traduce en que **un solenoide puede dispararse solo al prender el equipo**. Por eso
los pull-down de 10 kΩ en cada gate. Si quieren la solución más prolija: OE con un pull-up de
10 kΩ a VCC (salidas en alta impedancia al arrancar) y un GPIO que lo lleve a masa recién después
de que el firmware puso el registro en cero.

**Prueba:** cargá `nodo.ino`, levantá el backend y el gateway, y pedí una apertura desde la web.
El LED tiene que prenderse medio segundo. Si eso pasa, el software está completo y lo que falta
es solo potencia.

---

## 4. Los finales de carrera (30 min)

Un extremo del microswitch a **GND**, el otro al GPIO. En el firmware van como `INPUT_PULLUP`, así
que en reposo leen alto y al apretarse leen bajo. No hacen falta resistencias externas.

Los microswitch tienen tres patas: **COM**, **NO** (normalmente abierto) y **NC** (normalmente
cerrado). **No confíes en la posición**: en algunos modelos el terminal del medio no es COM. Mirá
lo impreso en el cuerpo del switch, o probalo.

**Se usan COM y NO**, con el switch montado de modo que la puerta cerrada apriete la palanca:

| Situación | Palanca | Contacto C-NO | Lectura | Estado |
|---|---|---|---|---|
| Puerta cerrada | apretada | cerrado | LOW | cerrada |
| Puerta abierta | libre | abierto | HIGH | abierta |

Usar NC invierte todo. Y hay una razón de seguridad para preferir NO: si se corta un cable o el
switch se afloja, el circuito queda abierto y el sistema reporta **puerta abierta**, que es el
estado seguro — salta la alerta en lugar de mostrar cerrada una puerta que no lo está.

Abrí el monitor serie a 115200 y verificá que aparezca el cambio al apretar cada uno. El
antirrebote ya está en el firmware, pero un contacto sucio puede generar lecturas erráticas: si
ves rebotes, subí `MS_ANTIRREBOTE`.

---

## 5. La potencia (1–2 h, la etapa donde se queman cosas)

> **Se puede hacer sin el registro de desplazamiento y sin radio.** Un MOSFET colgado de un GPIO
> alcanza para validar toda la cadena de una puerta. Usá
> `firmware/pruebas/prueba_actuador/prueba_actuador.ino`, que además busca por barrido la duración
> mínima de pulso que necesita la cerradura — ese número va después en `MS_PULSO_SOLENOIDE`.

Recién ahora los 12 V. Tres cosas que arruinan prototipos, en orden de frecuencia:

**Diodo flyback.** Un solenoide es una bobina: al cortar la corriente genera un pico de tensión
inverso que puede superar los 100 V y se lleva puesto el MOSFET. El 1N4007 va en paralelo con la
bobina, **cátodo (la franja) al positivo de 12 V**. Sin este diodo el MOSFET dura horas, no meses.

**Masa común.** El negativo de la fuente de 12 V y el GND del ESP32 tienen que estar unidos. Sin
esa referencia, el gate del MOSFET no tiene contra qué medir su tensión y el circuito hace cosas
impredecibles. Es el error más común y el más difícil de diagnosticar, porque a veces "casi"
funciona.

**No alimentes el XIAO desde los 12 V** sin un regulador. Para el prototipo, dejá el XIAO por USB
y la fuente de 12 V solo para los solenoides, con las masas unidas.

### El armado por MOSFET

```
   12 V ──┬──────────────┐
          │           [solenoide]
        [1N4007]         │
   (cátodo arriba)       │
          └──────────────┤
                         │
                       DRAIN
   Q0 del 595 ──[gate]  IRLZ44N
                  │    SOURCE
               [10 kΩ]    │
                  │       │
   GND ───────────┴───────┴──── (misma masa que el ESP32)
```

### Medición antes de confiar

Con la fuente de banco (si tienen) o el multímetro en serie, **medí cuánto consume un solenoide
durante el pulso**. Los de 12 V suelen pedir entre 0,5 y 1 A, con un pico mayor al inicio. Ese
número define la fuente. Poné el capacitor de 470–1000 µF cerca de los solenoides: absorbe el
pico y evita que la tensión se hunda y reinicie el ESP32.

El firmware acciona **de a un solenoide por vez** justamente por esto. No lo cambien para
"optimizar": cuatro solenoides simultáneos son un pico que la fuente del prototipo no aguanta.

**Y el registro vuelve a cero siempre.** Si un solenoide queda energizado se calienta, consume y
termina quemándose. Eso ya está en `accionarSolenoide()`, pero si tocan esa función, no lo saquen.

---

## 6. Integración con el servidor (30 min)

### Atajo: probar el sistema completo con UNA sola placa

Si todavía no tenés la segunda XIAO para el gateway, no hace falta esperar. Cargá
**`firmware/nodo_wifi/nodo_wifi.ino`**: esa placa se conecta al WiFi y habla HTTP directo con el
backend, haciendo el trabajo del gateway y del nodo a la vez. Con eso ya tenés el circuito
completo desde el navegador — solicitud, aprobación, apertura y estado real de la puerta.

Lo único a configurar son las tres primeras líneas: SSID, clave y la **IP de la PC** donde corre
el backend (la que da `ipconfig`, nunca `localhost`: desde la placa, localhost es la placa misma).

Dos condiciones: la PC y la placa en la misma red, y **el simulador apagado** — si los dos
consumen la cola de comandos, se pelean por ellos.

No es solo una muleta para la prueba: si el gabinete queda dentro del alcance del WiFi de la
facultad, esta arquitectura se puede dejar así y el proyecto se ahorra una placa entera. ESP-NOW
se justifica cuando el gabinete está fuera de cobertura o cuando no se quiere depender de la red.

### Con el gateway y el nodo separados

Con todo probado por separado:

1. Cargá `firmware/gateway/gateway.ino` en la placa que va conectada a la PC por USB.
2. Cargá `firmware/nodo/nodo.ino` en la del gabinete.
3. Apagá el simulador y levantá el puente serie:
   ```bash
   pip install pyserial websocket-client requests
   python gateway/gateway_serie.py --puerto COM4 --backend http://localhost:3000
   ```
   (En Windows el puerto es `COM3`, `COM4`, etc. — miralo en el Administrador de dispositivos.)
4. Pedí material desde el celular, aprobalo desde Alumnado, y la puerta se abre.

El backend no nota la diferencia entre el simulador y el hardware real: hablan el mismo protocolo.
Si algo falla, volvé a prender el simulador para confirmar que el problema está del lado físico y
no del software.

---

## 7. Montaje en el gabinete

Dejalo para el final, cuando todo funcione en la mesa. Al pasar del protoboard al mueble:

- **Los cables largos de los solenoides van lejos de los del microswitch.** Un pulso de 1 A
  induce ruido en un cable de señal que corre en paralelo, y aparecen lecturas fantasma de puerta.
- Las uniones del protoboard son la causa número uno de fallas intermitentes: si el prototipo va a
  quedar instalado, soldá o usá bornera.
- La antena, lo más despejada posible: adentro de una caja de chapa el alcance se desploma.
- Etiquetá cada cable con el número de casillero. En dos semanas nadie se acuerda cuál era el bit 2.

---

## Qué hacer si algo no anda

| Síntoma | Dónde mirar primero |
|---|---|
| `esp_now_init()` falla | Falta `WiFi.mode(WIFI_STA)` antes de iniciar |
| Las placas no se escuchan | **Canal distinto** entre las dos, o antena floja |
| Compila con error en el callback | Núcleo ESP32 2.x: la firma de `alRecibir` es distinta |
| El LED del 595 no prende | SRCLR debe estar en alto y OE en bajo; verificá orden de `shiftOut` y el pulso de latch |
| Prenden LEDs equivocados | Orden de bits: probá cambiar `MSBFIRST` por `LSBFIRST` |
| El solenoide no mueve | Tensión gate-source con el multímetro durante el pulso: si es baja, el 595 no está entregando nivel suficiente (ver etapa 3) |
| El ESP32 se reinicia al accionar | La fuente se hunde: falta el capacitor, o la fuente es chica |
| El MOSFET se calienta | No satura: pasar a HCT a 5 V, o revisar que sea IRLZ (versión lógica) y no IRF |
| Lecturas de puerta erráticas | Cable del microswitch corriendo junto al de potencia; subir el antirrebote |
| Anda en la mesa y falla en el gabinete | Uniones del protoboard, o antena tapada por la chapa |

---

## Orden sugerido para el viernes

| Momento | Qué |
|---|---|
| Antes | Instalar IDE, paquete ESP32 y librerías (etapa 0) |
| Primera hora | Blink en las dos placas (etapa 1) |
| Resto de la mañana | **Enlace ESP-NOW y medición de alcance** (etapa 2) |
| Tarde | Registro con LEDs (etapa 3) y microswitches (etapa 4) |
| Otro día | Potencia (etapa 5) e integración (etapa 6) |

Si terminan con dos placas hablándose por ESP-NOW y un LED que prende cuando alguien pide material
desde el celular, el proyecto está prácticamente hecho: lo que queda es un MOSFET y un diodo por
puerta.
