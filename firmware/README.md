# Firmware de los lockers — ESP-IDF 6.1 con VS Code

Desde octubre de 2026 el firmware **no usa más el IDE de Arduino**: son proyectos **ESP-IDF
nativos** (C con FreeRTOS), que se compilan, graban y monitorean desde **VS Code con la extensión
oficial de Espressif**. Es la misma base que adoptó la cátedra para la mesh de AURA
([ADR-007](https://github.com/Universidad-Nacional-de-Rafaela/aura-firmware/blob/main/docs/adr/ADR-007-mesh-en-esp-idf-con-concentrador-por-aula.md)):
**ESP-IDF 6.1**, instalador **EIM**, componentes compartidos en `componentes/`, `sdkconfig.defaults`
por placa, cJSON desde el registro de Espressif y los secretos en un `config_local.h` que no se sube.

El protocolo con el backend **no cambió** (ver [`PROTOCOLO.md`](PROTOCOLO.md)): el servidor, el
puente `gateway_serie.py` y los simuladores siguen igual.

---

## 1. Qué hay acá

```
firmware/
├── lockers.code-workspace      abrir ESTO en VS Code: trae todos los proyectos
├── componentes/                código compartido (lo usan varios proyectos)
│   ├── puertas/                solenoides + microswitches: pulso de 15 s sin bloquear,
│   │                           máx. 2 bobinas a la vez, antirrebote, salida por GPIO o 74HC595
│   └── enlace_espnow/          radio ESP-NOW por difusión, con cola de recepción y RSSI
├── nodo_wifi/                  ESP32-C3 SuperMini · el gabinete habla HTTP directo por WiFi
├── nodo/                       XIAO ESP32S3 · el gabinete por ESP-NOW (74HC595 + 4 puertas)
├── gateway/                    XIAO ESP32S3 · puente USB ↔ ESP-NOW (para gateway_serie.py)
├── pruebas/
│   ├── obtener_mac/            imprime la MAC (y el hw_id de AURA) de cualquier placa
│   ├── prueba_espnow/          ping-pong con RTT, RSSI y % de entrega: mide el alcance
│   └── prueba_actuador/        un MOSFET + un switch por consola: barrido y pulso de 15 s
└── PROTOCOLO.md                contrato de tramas firmware ↔ servidor
```

Cada proyecto tiene la estructura estándar de ESP-IDF:

| Archivo | Para qué |
|---|---|
| `CMakeLists.txt` | El proyecto (`project(...)`); suma `../componentes` |
| `sdkconfig.defaults` | Ajustes de la placa: target, flash, consola por USB, tick de 1 ms. El `sdkconfig` se genera al compilar y no se versiona |
| `main/main.c` | El firmware, comentado |
| `main/CMakeLists.txt` | `idf_component_register(...)` con los componentes que usa |
| `main/idf_component.yml` | Componentes externos: `espressif/cjson` (en ESP-IDF 6.x ya no viene adentro) |
| `main/config_local.ejemplo.h` | Solo en `nodo_wifi`: plantilla de **red WiFi, IP del backend y API key** |

### Qué proyecto va en qué placa

| Proyecto | Placa | Target | Necesita `config_local.h` |
|---|---|---|---|
| `nodo_wifi` | ESP32-C3 SuperMini (4 MB) | `esp32c3` (ya fijado) | **Sí** |
| `nodo` | Seeed XIAO ESP32S3 (8 MB) | `esp32s3` (ya fijado) | No |
| `gateway` | Seeed XIAO ESP32S3 (8 MB) | `esp32s3` (ya fijado) | No |
| `pruebas/*` | cualquiera de las dos | **elegilo vos**: `esp32s3` o `esp32c3` | No |

Las dos arquitecturas siguen disponibles: **una placa** (`nodo_wifi`, la que usan hoy) o **dos
placas** (`gateway` + `nodo` por ESP-NOW, para un gabinete fuera del WiFi).

---

## 2. Instalar (una sola vez)

1. **VS Code** desde code.visualstudio.com.
2. Extensión **ESP-IDF** de Espressif (`espressif.esp-idf-extension`): `Ctrl+Shift+X`, buscar
   "ESP-IDF", Instalar. Al abrir el workspace VS Code la sugiere sola.
3. `F1` → **ESP-IDF: Open ESP-IDF Installation Manager**. Se baja y abre **EIM**. Instalá
   **ESP-IDF v6.1** (la misma de la cátedra) con los targets **esp32s3** y **esp32c3**.
   Tarda: son ~2 GB entre el framework y los compiladores.
4. `F1` → **ESP-IDF: Doctor Command** para confirmar que quedó todo bien.

> **Rutas:** el proyecto tiene que estar en una carpeta **local, sin espacios ni tildes y fuera de
> OneDrive o Google Drive**. `C:\Users\matia\Music\...` suele estar sincronizada con OneDrive: mejor
> `C:\proyectos\lockers-unraf`.
>
> **Windows:** si aparecen errores de codificación en Python, creá la variable de entorno de
> usuario `PYTHONUTF8=1` y reiniciá VS Code (lo documentó la cátedra).

---

## 3. Abrir, compilar, grabar y monitorear

1. **File → Open Workspace from File…** → `firmware/lockers.code-workspace`.
   (No abras `firmware/` como carpeta suelta: la extensión no reconoce los proyectos adentro.)
2. Elegí el **proyecto activo**: botón **ESP-IDF: Current Project** en la barra de estado, o
   `F1` → **ESP-IDF: Pick a Workspace Folder**. Todo lo que sigue actúa sobre ese proyecto.
3. `F1` → **ESP-IDF: Select Current ESP-IDF Version** → la v6.1 que instalaste (una vez por proyecto).
4. **Solo `nodo_wifi`:** copiá `main/config_local.ejemplo.h` como `main/config_local.h` y completá
   la red, la IP de la PC donde corre el backend y la API key. Sin ese archivo no compila (a
   propósito: el error dice qué hacer).
5. **Solo `pruebas/*`:** `F1` → **ESP-IDF: Set Espressif Device Target** → `esp32s3` (XIAO) o
   `esp32c3` (SuperMini). Los demás proyectos ya lo traen fijado en `sdkconfig.defaults`.
6. Conectá la placa y `F1` → **ESP-IDF: Select Port to Use** (en Windows, `COM3`, `COM4`…).
7. **ESP-IDF: Build your Project** → **ESP-IDF: Flash your Project** (método UART) →
   **ESP-IDF: Monitor Device**. O los tres juntos con **ESP-IDF: Build, Flash and Monitor**.
   Los mismos comandos están como íconos en la barra de estado.

**La primera compilación necesita internet**: baja cJSON del registro de Espressif a
`managed_components/` y crea `dependencies.lock`. Subí ese `dependencies.lock` al repo (fija la
versión, como hace la cátedra); `managed_components/` no se sube.

**Desde la terminal** (`F1` → **ESP-IDF: Open ESP-IDF Terminal**), lo mismo con `idf.py`:

```bash
cd firmware/nodo_wifi
idf.py set-target esp32c3        # solo la primera vez (o en las pruebas, para cambiar de placa)
idf.py -p COM4 build flash monitor
```

Para salir del monitor: `Ctrl+]`.

---

## 4. Pines

### `nodo_wifi` — ESP32-C3 SuperMini

| Locker | bit | Solenoide (gate del MOSFET) | Microswitch |
|---|---|---|---|
| A-01 | 0 | GPIO0 | GPIO5 |
| A-02 | 1 | GPIO1 | GPIO6 |
| A-03 | 2 | GPIO3 | GPIO7 |
| A-04 | 3 | GPIO4 | GPIO10 |

Son los mismos que en la versión Arduino. Se evitan GPIO2, 8 y 9 (pines de arranque) y 18/19 (el USB).

### `nodo` — XIAO ESP32S3 + 74HC595

En ESP-IDF no existen los nombres `D1`…`D7` de Arduino: se usa el número de GPIO.

| Función | En la placa | GPIO |
|---|---|---|
| 595 SER (pin 14) | D1 | 2 |
| 595 SRCLK (pin 11) | D2 | 3 |
| 595 RCLK (pin 12) | D3 | 4 |
| Microswitch A-01 | D4 | 5 |
| Microswitch A-02 | D5 | 6 |
| Microswitch A-03 | D6 | **43** |
| Microswitch A-04 | D7 | **44** |

> ⚠ **D6 y D7 son el TX/RX de la UART0.** Por eso `nodo` lleva la consola en el USB nativo
> (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`): con la consola por defecto, esos dos pines quedarían
> tomados por la UART. Igual la ROM del chip escribe en GPIO43 durante el arranque (~100 ms),
> y con la puerta cerrada el pin está a GND por el switch: eso es un cortocircuito breve en cada
> encendido. Poné **1 kΩ en serie** en esos dos cables, o pasá los switches a D8/D9 (GPIO7/8)
> y cambiá `PIN_MICROSWITCH` en `nodo/main/main.c`.

Los tiempos y límites (15 s de pulso, 2 bobinas a la vez, 300 ms entre arranques, antirrebote de
50 ms) están en `#define` al principio de cada `main.c`, igual que antes.

---

## 5. Lo que cambió respecto de Arduino

| Arduino | ESP-IDF | Dónde se ve |
|---|---|---|
| `setup()` + `loop()` | `app_main()` que crea **tareas** de FreeRTOS | cada `main.c` |
| un `loop()` que hace todo | `puertas` (potencia y switches), `comandos`, `telemetria`, cada una en su tarea | `nodo_wifi` |
| `delay()` / `millis()` | `vTaskDelay(pdMS_TO_TICKS(ms))` / `esp_timer_get_time()` (64 bits: no da la vuelta) | todo |
| `Serial.printf` | `ESP_LOGI(TAG, ...)` (con nivel y nombre del módulo) o `printf` | todo |
| `WiFi.begin()` | `esp_wifi_*` + eventos (`WIFI_EVENT_STA_DISCONNECTED`, `IP_EVENT_STA_GOT_IP`) | `nodo_wifi` |
| `HTTPClient` | `esp_http_client`, una conexión persistente por tarea | `nodo_wifi` |
| `ArduinoJson` | `cJSON` del registro de Espressif (`espressif/cjson`) | nodos |
| `pinMode` / `digitalWrite` | `gpio_config()` / `gpio_set_level()` | `componentes/puertas` |
| "USB CDC On Boot: Enabled" | `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` en `sdkconfig.defaults` | todos |
| credenciales en el `.ino` | `main/config_local.h`, en el `.gitignore` | `nodo_wifi` |

**Por qué el pulso no bloquea.** Con 150 ms daba igual un `delay()`; con 15 s, no. Una sola tarea
(`componentes/puertas`) es dueña de las salidas: recibe las órdenes por una cola, apaga cada bobina
al vencer y lee los switches cada 5 ms. Un pedido HTTP colgado 3 s, o una trama de radio que
tarda, no pueden demorar el corte de un solenoide.

**Por qué el ACK sale cuando arranca el pulso.** El backend cuenta los 15 s desde el ACK (es la
cuenta regresiva que ve la persona). Si una orden tiene que esperar turno (ya hay 2 bobinas
energizadas), el ACK espera con ella.

---

## 6. Si algo no anda

| Síntoma | Causa y solución |
|---|---|
| `Falta main/config_local.h` | Copiá `config_local.ejemplo.h` como `config_local.h` (solo `nodo_wifi`) |
| `cJSON.h: No such file or directory` | La primera compilación no pudo bajar cJSON: hace falta internet. Volvé a compilar con conexión |
| Cambié `sdkconfig.defaults` y no hace nada | Los defaults solo se aplican al crear el `sdkconfig`. Borrá `sdkconfig` y la carpeta `build` (o **ESP-IDF: Full Clean Project**) y recompilá |
| El monitor queda mudo | Puerto equivocado, o la placa quedó en modo descarga: apretá RESET. La C3 SuperMini no siempre se reinicia sola después de grabar |
| No graba / no aparece el puerto | Mantené **BOOT**, conectá el USB, soltá. Cable de datos, no solo de carga |
| `Elegí el target: esp32s3 (XIAO) o esp32c3 (SuperMini)` | En las pruebas hay que fijar el target (paso 5 de la sección 3) |
| La C3 SuperMini no engancha el WiFi o se reinicia al conectar | Antena de fábrica mal adaptada: `POTENCIA_TX 34` (8,5 dBm) en `config_local.h`. Con antena de alambre de 31 mm, 60 (15 dBm) |
| `Sin WiFi (motivo 201)` en bucle | No encuentra la red: es de 5 GHz, o el SSID está mal escrito |
| `Sin WiFi (motivo 15)` o `(motivo 204)` | Clave incorrecta |
| `GET /api/gateway/comandos -> ESP_ERR_HTTP_CONNECT` | `BACKEND_URL` con `localhost` (desde la placa, localhost es la placa) o el firewall de Windows bloqueando Node.js en red privada |
| `HTTP 401` | `API_KEY` distinta de `GATEWAY_API_KEY` del `.env` |
| Las placas ESP-NOW no se escuchan | **Canal distinto** (`CANAL` en `nodo`, `gateway` y `prueba_espnow`), o antena floja |
| `out of memory` / se muere `cc1` al compilar | Poca RAM libre: cerrá Docker o WSL (`wsl --shutdown`) |
| Compila con Clang en vez de GCC | `CMakeLists.txt` de la raíz vacío o sin guardar al hacer Set Target: guardá, borrá `build` y repetí |
| `CMake Warning ... Private include directory ... wpa_supplicant` | Aviso interno de ESP-IDF 6.1 (sale también en sus ejemplos): no es un error |

**Regla general** (de la cátedra): corregir, guardar (Auto Save está activado en el workspace),
borrar `build` y recompilar.

---

## 7. Verificación

Los seis proyectos compilan **sin un solo warning de su código** con ESP-IDF 6.1 (GCC 15.2), y
las pruebas en los dos targets:

| Proyecto | Target | Binario | Libre en su partición |
|---|---|---|---|
| `nodo_wifi` | esp32c3 | 949 KB | 37 % (de 1,5 MB) |
| `nodo` | esp32s3 | 740 KB | 51 % (de 1,5 MB) |
| `gateway` | esp32s3 | 728 KB | 51 % (de 1,5 MB) |
| `pruebas/obtener_mac` | esp32s3 / esp32c3 | 150 KB / 126 KB | 85 % / 88 % (de 1 MB) |
| `pruebas/prueba_espnow` | esp32s3 / esp32c3 | 728 KB / 767 KB | 29 % / 25 % (de 1 MB) |
| `pruebas/prueba_actuador` | esp32s3 / esp32c3 | 174 KB / 151 KB | 83 % / 85 % (de 1 MB) |

Al configurar los proyectos con WiFi, CMake muestra avisos `Private include directory ... belongs
to component esp_wifi but is being used by component wpa_supplicant`. **Son de ESP-IDF 6.1, no
del proyecto**: el ejemplo oficial `examples/wifi/espnow` da los mismos. Se pueden ignorar.

`nodo_wifi` casi no entra en la partición por defecto de 1 MB (le quedaría 7 %): por eso `nodo_wifi`,
`nodo` y `gateway` usan *Single factory app (large)*, de 1,5 MB. Las pruebas usan la de 1 MB.

**Falta probarlo en placa.** La lógica es la de los `.ino` que ya andaban, pero el primer arranque
de cada proyecto conviene hacerlo con el monitor abierto y el simulador apagado.
