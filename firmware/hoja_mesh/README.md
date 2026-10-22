# Hoja de la mesh — gabinete de lockers del pañol

Esta carpeta es la **ficha del dispositivo**, con el formato de `dispositivos/` del repositorio
[`aura-firmware`](https://github.com/Universidad-Nacional-de-Rafaela/aura-firmware) de la cátedra.
Cuando la cátedra le asigne un código, el proyecto se copia tal cual a `dispositivos/<CÓDIGO>/`
(ver *Pasarlo a aura-firmware*, más abajo).

| | |
|---|---|
| **Código** | **a definir con la cátedra**. Propuesta: `E1-PB-PANL-LCK01` (falta confirmar el edificio, el piso y el recinto del pañol; `PANL` y `LCK` se agregan al mapa en el mismo PR) |
| **Ubicación** | Pañol, gabinete de 4 lockers |
| **Responsable** | grupo de Lockers UNRaf (Ingeniería en Computación) |
| **Estado** | en desarrollo: compila para las dos placas y se probó con el broker de banco y una hoja simulada. **Falta probarla en placa.** |
| **Transporte** | mesh ESP-WIFI-MESH (interior), ADR-006 y ADR-007 de aura-firmware |
| **Contrato que implementa** | `docs/CONTRATO_MQTT.md` **v4.1** de aura-firmware |
| **Basado en** | `Mesh_Red_Completa/Mesh3_Hoja` (biblioteca `nodo_mesh`) + nuestro componente `puertas` |

## Qué hace

Acciona el solenoide de cada puerta cuando AURA le manda el comando `abrir`. Además lee el
microswitch de cada puerta y publica en `values` el estado de las puertas y de los solenoides.
Las reglas del préstamo (código, 15 s para abrir, alerta a los 45 s, mora) **no viven acá**: las
aplica el backend de lockers, que recibe las mediciones y manda las órdenes a través del puente
MQTT (`gateway/puente_mesh.py`).

```
backend de lockers ── HTTP ── puente_mesh.py ── MQTT hw/<hw_id>/… ── broker de AURA
                                                                        │
                                       gateway (raíz) ── mesh ── concentrador del aula ── ESTA HOJA
```

## Hardware

Se elige con el *target* de ESP-IDF; el `main.c` es el mismo.

| Target | Placa | Solenoides | Microswitches | LED |
|---|---|---|---|---|
| `esp32c3` (por defecto) | ESP32-C3 SuperMini, 4 MB | GPIO **0, 1, 3, 4** → gate del IRLZ44N (uno por puerta) | GPIO **5, 6, 7, 10** | GPIO 8 |
| `esp32s3` | Seeed XIAO ESP32S3, 8 MB | SN74HC595: SER **D1** (GPIO2), SRCLK **D2** (GPIO3), RCLK **D3** (GPIO4); salidas Q0–Q3 | **D4, D5, D6, D7** (GPIO 5, 6, 43, 44) | GPIO 21 |

Son los mismos pines que `nodo_wifi` (C3) y que el nodo ESP-NOW (XIAO): el cableado del gabinete
no cambia. El microswitch se conecta entre el pin y GND, con COM y NO (puerta cerrada = palanca
apretada = LOW). Así, un cable cortado se lee como **abierta**, que es el estado seguro.

**Antena.** La C3 SuperMini tiene la antena mal adaptada. La cátedra usa `potencia_tx 60` (15 dBm)
con un alambre de 31 mm, y con eso consiguió ~10 m a través de una vidriera. No conviene subirla:
acá la misma fuente alimenta los solenoides.

**LED.** Fijo: en la malla y con aula. Parpadeo lento (1 Hz): en la malla pero sin aula, o sea,
AURA todavía no la asignó. Parpadeo rápido (4 Hz): buscando la malla.

## Lo que envía a AURA

Cada medición es un `values` (contrato §3.1). Sale una **en cada cambio** de un switch o de un
solenoide, y una completa cada `intervalo_s`:

```json
{"puerta_1":0,"puerta_2":1,"puerta_3":0,"puerta_4":0,"solenoide_1":0,"solenoide_2":1,"solenoide_3":0,"solenoide_4":0}
```

| Campo | Unidad | Rango válido | Cada cuánto |
|---|---|---|---|
| `puerta_1` … `puerta_4` | estado (1 = abierta, 0 = cerrada) | 0 o 1 | en cada cambio + cada `intervalo_s` |
| `solenoide_1` … `solenoide_4` | estado (1 = energizado, 0 = trabado) | 0 o 1 | en cada cambio + cada `intervalo_s` |

Son unos 120 bytes de JSON; el límite de `values` es 160. Con más de 4 puertas por placa habría
que acortar los nombres.

**Alertas** (`hw/<hw_id>/alerts/puerta`, una por cambio):

| `details.motivo` | `severity` | Cuándo |
|---|---|---|
| `apertura_sin_orden` | `high` | la puerta se abrió sin que su solenoide estuviera energizado (puerta forzada o traba floja). Hay 3 s de gracia después de cada pulso. |
| `abierta_demasiado` | `warning` | la puerta lleva más de `max_abierta_s` abierta (`details.segundos`) |
| `cerrada` | `info` | se cerró una puerta que tenía alguna de las dos alertas anteriores |

`details.puerta` es el número de puerta (1 a 4).

## Comandos

| Comando | `params` | Qué hace | Rechazos (`details.motivo`) |
|---|---|---|---|
| `abrir` | `puerta` (1–4, obligatorio), `ms` (100–20 000; por defecto 15 000), `id` (opcional: el id de la orden en el backend, solo para el log) | Energiza el solenoide de esa puerta durante `ms`. Contesta `aplicado` en cuanto la orden queda tomada; si la puerta ya está energizada, extiende el pulso. | `puerta_fuera_de_rango`, `ms_fuera_de_rango`, `puertas_ocupadas`, `orden_local_no_permitida` |
| `set_config` | ver *Configuración* | | `parametro_desconocido`, `intervalo_s_fuera_de_rango`, `max_abierta_s_fuera_de_rango`, `aula_invalida` |

Ejemplo: `{"command":"abrir","params":{"puerta":1,"ms":15000},"command_id":"lk-12"}` (≤ 180 bytes).

- **El botón del concentrador no abre puertas.** Una orden `local` de `abrir` se rechaza: solo el
  backend de lockers, que validó el código de la persona, puede abrir una puerta.
- **Fuente:** como máximo 2 bobinas a la vez, con 300 ms entre arranques. Una tercera orden queda
  esperando turno, aunque ya se haya contestado `aplicado`. El arranque real se ve en `solenoide_N`.
- **Protección de la bobina:** ninguna orden puede pasar de 20 s. El componente `puertas` corta el
  pulso al vencer, aunque se pierda la comunicación.

## Configuración

Los parámetros se cambian con `set_config` (contrato §3.3). Se valida **todo o nada** y se guarda en
NVS. El aula la maneja `nodo_mesh`.

| Parámetro | Rango | Por defecto |
|---|---|---|
| `aula` | `a-z 0-9 - _`, de 1 a 15 caracteres | — (la asigna AURA) |
| `intervalo_s` | 5 a 3600 | 30. Con este valor la raíz marca la hoja `offline` a los 90 s sin datos. |
| `max_abierta_s` | 30 a 3600 | 120 |

`describir_config` informa además `puertas: 4`.

## Compilar y grabar (VS Code + extensión ESP-IDF 6.1)

1. Bajar el submódulo con los componentes de la mesh. Hay que hacerlo **una sola vez** después de
   clonar:
   ```
   git submodule update --init
   ```
   Si no, la compilación avisa: *No encuentro los componentes de la mesh*. También se puede apuntar
   a otra copia de aura-firmware con la variable de entorno `AURA_FIRMWARE`.
2. Copiar `main/config_local.ejemplo.h` como `main/config_local.h` y completar `MESH_ID_BYTES` y
   `MESH_AP_PASS`, **que los da la cátedra**. Este archivo **no se sube**: está en el `.gitignore`.
   La hoja **no** necesita el WiFi del edificio ni la dirección del backend.
3. En VS Code: proyecto activo **hoja_mesh**, *Set Espressif Device Target* → `esp32c3` (SuperMini)
   o `esp32s3` (XIAO), puerto, y **Build, Flash and Monitor**. Si cambiás de target, *Full Clean*
   antes.
4. En el monitor, al arrancar, `nodo_mesh` imprime su `hw_id` (`mac-…`). Ese es el dato que se le
   pasa a la cátedra para dar de alta la placa y al puente con `--nodo NODO-A=mac-…`.

## Probar sin placa y en banco

- **Sin ninguna placa:** `broker.py` de la cátedra + backend + `gateway/simulador_hoja_mesh.py` +
  `gateway/puente_mesh.py` (ver `firmware/README.md`, sección *Red mesh de AURA*).
- **En banco con la mesh de la cátedra:** gateway y concentrador con `broker.py`. La hoja aparece
  **pendiente** en el tablero; se le asigna el aula y pasa a `modo: aula`. Después se le manda
  `abrir` desde el tablero o con el backend y el puente andando.
- **Checklist de la guía:** un `set_config` inválido devuelve `rechazado` con motivo y la config no
  cambia; con el concentrador apagado, la hoja pasa a `directo` y vuelve sola.

## Pasarlo a aura-firmware (PR a la cátedra)

1. Fork de aura-firmware y una rama.
2. Copiar esta carpeta como `dispositivos/<CÓDIGO>/`, sin `build/`, `sdkconfig` ni
   `main/config_local.h`.
3. Copiar `firmware/componentes/puertas` como `dispositivos/<CÓDIGO>/components/puertas`. El
   `CMakeLists.txt` ya busca los componentes de la mesh en `../../Mesh_Red_Completa/componentes` y
   usa `components/puertas` si está.
4. Cambiar `project(hoja_lockers)` por el código en minúsculas. Agregar el recinto y el tipo
   (`LCK`, actuador) al mapa de `dispositivos/README.md`, y la carpeta a `CODEOWNERS`.
5. Compilarlo (el CI de aura-firmware todavía no compila ESP-IDF) y abrir el PR contra `main`.
