# Pañol automatizado — Lockers UNRaf

Plataforma web para administrar el material compartido de la universidad con **reservas por
franja horaria**, retiro y devolución **frente a la puerta con un código de operación**, apertura
por solenoide (pulso de 15 s) verificada con microswitch, y trazabilidad completa.
Prototipo de 4 lockers — Ingeniería en Computación, Universidad Nacional de Rafaela.

> **v3** — Implementa la *Especificación Técnica y Funcional* (`ESPECIFICACION.md`): roles con
> reglas propias, bloques de 1 a 4 h, tolerancia de 15 min, buffer de 30 min, stock bloqueado por
> unidades y por horario, máquina de estados de 9 estados, devolución híbrida con auditoría,
> mora con sanción automática y reasignación del turno siguiente.
> El modelo y las decisiones están en `MODELO-DE-DATOS.md`.

---

## 1. Arquitectura de carpetas

```
lockers-unraf/
├── ESPECIFICACION.md              la especificación que implementa esta versión
├── backend/                       API REST + WebSocket + SQLite (backend/data/lockers.db)
│   ├── src/
│   │   ├── server.js              punto de entrada (HTTP + WS + watchdog cada 5000 ms)
│   │   ├── app.js                 Express: API + los tres frontends como estáticos
│   │   ├── config/                env.js (todas las reglas, configurables) · database.js
│   │   ├── db/                    schema.sql (v4) · seed.js · verificar.js
│   │   ├── middleware/            auth.js (admin · usuario · operación · gateway)
│   │   ├── routes/index.js        mapa completo de la API, documentado arriba del archivo
│   │   ├── controllers/           auth · usuario · locker (QR) · operacion · admin · gateway
│   │   ├── services/
│   │   │   ├── prestamo.service.js    reglas por rol, franjas, máquina de estados, mora, mitigación
│   │   │   ├── operacion.service.js   código -> pulso 15 s -> switch; reintento; faltantes; 45 s
│   │   │   ├── locker.service.js      stock por franja (pico de unidades bloqueadas)
│   │   │   ├── usuario.service.js     padrón, PIN con bcrypt, sanciones
│   │   │   ├── auditoria.service.js   logs_auditoria (trazabilidad física)
│   │   │   ├── evento.service.js      bitácora de negocio
│   │   │   ├── comando.service.js     cola de órdenes hacia la radio (con duración del pulso)
│   │   │   ├── telemetria.service.js  lecturas de los microswitches
│   │   │   ├── alerta.service.js      avisos en tiempo real a Alumnado
│   │   │   └── watchdog.service.js    no-show, mora, buffer, mitigación, puertas
│   │   ├── realtime/hub.js        WebSocket por rol, por legajo y por locker
│   │   └── utils/                 reloj (hora local del pañol) · logger · errores
│   └── test/escenarios.test.js    22 escenarios del ciclo de vida (npm test)
├── frontend/
│   ├── usuario/index.html         app de alumnos y docentes: reservar franja · mis reservas
│   ├── locker/index.html          pantalla de la puerta (destino del QR): código · pulso · switch
│   └── admin/                     Mesa de Alumnado (index.html) y hoja de QR para imprimir (qr.html)
├── gateway/
│   ├── gateway_serie.py           puente serie ↔ HTTP/WS entre el backend y la radio
│   ├── simulador_nodo.js          gateway + nodo + persona: el sistema completo sin hardware
│   └── simulador_nodo.py          lo mismo, en Python
├── firmware/                      ESP-IDF 6.1 + VS Code (ver firmware/README.md)
│   ├── lockers.code-workspace     se abre esto en VS Code: trae todos los proyectos
│   ├── PROTOCOLO.md               contrato de tramas firmware ↔ servidor
│   ├── componentes/               puertas (pulso 15 s, switches) · enlace_espnow (radio)
│   ├── nodo_wifi/                 ESP32-C3 SuperMini: el gabinete habla HTTP por WiFi
│   ├── nodo/                      XIAO ESP32S3 del gabinete: ESP-NOW + SN74HC595 + microswitches
│   ├── gateway/                   XIAO ESP32S3 puente: USB ↔ ESP-NOW
│   └── pruebas/                   de banco: MAC, enlace ESP-NOW, actuador con pulso de 15 s
├── arrancar.bat / arrancar.sh     doble clic: servidor + simulador + navegador
└── ARRANCAR-HOY.md · PUESTA-EN-MARCHA.md · HARDWARE.md · MODELO-DE-DATOS.md
```

Los frontends son un archivo cada uno, sin build: el pañol puede no tener buena señal.

---

## 2. Puesta en marcha

Requiere **Node 22.5 o superior** (usa el SQLite incluido en Node; sin dependencias nativas).

```bash
cd backend
cp .env.example .env          # cambiá JWT_SECRET y GATEWAY_API_KEY
npm install                   # en PowerShell: npm.cmd install
rm -rf data                   # el esquema cambió a v4: hay que rehacer la base
npm run seed
npm start
npm test                      # opcional: 22 escenarios con el reloj simulado
```

| URL | Para quién |
|---|---|
| `http://IP:3000/` | App de alumnos y docentes |
| `http://IP:3000/locker/A-01` | Pantalla de la puerta A-01 (lo que abre su QR) |
| `http://IP:3000/admin` | Mesa de Alumnado |
| `http://IP:3000/admin/qr.html` | Hoja con los QR de las 4 puertas para imprimir |

Credenciales de prueba (los PIN se guardan con bcrypt; `npm run verificar` los recuerda):

| Quién | Acceso | Reglas |
|---|---|---|
| Alumnado | `alumnado` / `unraf2025` | gestión total |
| Alumno | `10234` / `4821` · `10235` / `7390` | 1 unidad, solo hoy, 1 préstamo activo, siempre con aprobación |
| Docente | `20011` / `1145` · `20012` / `2468` | hasta el 100% del stock, hasta 7 días, 1 reserva activa, aprobación solo si pide > 50% de la capacidad |

Inventario: A-01 25 notebooks · A-02 10 zapatillas · A-03 50 fibrones · A-04 12 kits Arduino.

**Firmware:** son proyectos **ESP-IDF 6.1** que se compilan y graban desde **VS Code** con la
extensión de Espressif (ya no se usa el IDE de Arduino). Instalación, pines y problemas frecuentes
en [`firmware/README.md`](firmware/README.md).

**Sin hardware:** con el backend corriendo, `node gateway/simulador_nodo.js` hace de gateway, de
nodo y de persona que abre y cierra la puerta. Para ensayar las fallas de la especificación:

```bash
node gateway/simulador_nodo.js --no-abre A-02   # nadie abre: a los 15 s aparece "Reintentar apertura"
node gateway/simulador_nodo.js --trabar A-04    # queda abierta: alerta a los 45 s, ERROR a los 120 s
node gateway/simulador_nodo.js --cierre 50      # la cierra a los 50 s: dispara la alerta y después cierra
node gateway/simulador_nodo.js --perder 30      # radio que pierde el 30% de las órdenes
```

> La v2 tenía un "modo demo" que corría sin servidor. Con franjas, códigos y pulsos la lógica vive
> en el backend, así que para mostrar la interfaz se usa el simulador (o `arrancar.bat`).

---

## 3. El circuito completo

**1. Reserva (app, `/`).** La persona elige **fecha** (alumno: hoy; docente: hasta 7 días),
**hora de inicio** (pasos de 15 min dentro del horario) y **duración** (1, 2, 3 o 4 h). El catálogo
muestra cuántas unidades quedan libres **en esa franja**. Al reservar:

- Docente pidiendo ≤ 50% de la capacidad → **`RESERVADO`** al instante, con un **código de 6 dígitos**.
- Alumno, o docente pidiendo > 50% → **`PENDIENTE_APROBACION`**: aparece en el panel con aviso
  sonoro; al aprobar, la persona recibe el código por WebSocket.

**2. Retiro (`/locker/A-01`, entre la hora de inicio y +15 min).** Cada puerta tiene un QR fijo que
abre su pantalla. Se ingresa el código → el servidor valida que sea **de ese locker** y **dentro de
la ventana**, registra `PULSO_APERTURA_RETIRO` y encola la orden: el ESP32 energiza el solenoide
**15 s**. La pantalla muestra la cuenta regresiva.

- El switch reporta **ABIERTO** → "Retirá N × material" + botón **Reportar faltante/incidencia**.
- Pasan 15 s sin apertura → **Reintentar apertura** (no penaliza la reserva).
- El switch reporta **CERRADO** → el préstamo pasa a **`EN_USO`**.
- Si la puerta sigue abierta a los **45 s** → alerta visual y sonora en el celular y en el panel.
- Nadie validó el código a los 15 min → **`CANCELADO_NO_SHOW`**, libera las unidades al instante.

**3. Devolución (antes de la hora límite).** Mismo QR y mismo código (o *Iniciar devolución* desde
la app). Al cerrar la puerta, el **modelo híbrido** decide:

- **Camino A** — docente, ≤ 50%, en término → `BUFFER_30_MIN` → `FINALIZADO` a los 30 min, solo.
- **Camino B** — alumno, > 50% o en mora → `PENDIENTE_AUDITORIA`: alerta amarilla *"Verificar
  reingreso físico en Locker A-01"*; las unidades vuelven al stock con **Confirmar Stock OK**
  (o *Con diferencia…*, que descuenta lo faltante y opcionalmente sanciona).

**4. Mora.** A la hora límite, un préstamo `EN_USO` pasa a **`EN_MORA`**, el legajo queda
**sancionado** (no puede reservar hasta que Alumnado lo rehabilite) y la fila aparece en rojo con los
minutos de demora. A 15 min del turno siguiente, si el stock no alcanza, el sistema **reasigna** la
reserva a otro locker con el mismo material (con código nuevo) o, si no hay, avisa para entregar
**material de respaldo en ventanilla**.

---

## 4. Cómo conversan el backend y el hardware

El backend **nunca abre una puerta: encola una orden** con la duración del pulso.

```
Código válido en /locker/A-01
   ├── logs_auditoria: PULSO_APERTURA_RETIRO (legajo, locker, timestamp)
   ├── comando ABRIR { id, nodo, bit, ms: 15000 }      → 202 al instante
   │        gateway → serie → XIAO → ESP-NOW → nodo        (o la placa WiFi lo pide por HTTP)
   │        nodo energiza el bit 15 s (sin bloquear) → ACK con el mismo id
   ├── microswitch ABIERTO → PUERTA_ABIERTA  (atribuido a quien validó el código)
   └── microswitch CERRADO → PUERTA_CERRADA → RESERVADO pasa a EN_USO
```

- **Una operación por locker a la vez.** Varias reservas comparten la puerta (stock parcial), pero
  el switch es uno: se le atribuye a quien validó el código. Así "el último legajo que cerró el
  locker" —el presunto responsable de un faltante— es un dato confiable.
- **Reintentos con `id`** (5 s, hasta 3 veces) y **vigencia de 30 s**: una orden que el gateway no
  tomó a tiempo se descarta, para no destrabar una puerta sin nadie adelante.
- **El microswitch manda.** Un ACK sin apertura posterior es exactamente el caso de *Reintentar*.

---

## 5. Límites conocidos

**El sistema registra lo declarado, no lo que salió de la caja.** Si alguien reserva 5 y se lleva 6,
el software no se entera. Lo mitigan el reporte de faltantes (con el último responsable) y la
auditoría de Alumnado en las devoluciones críticas; la certeza real necesitaría RFID o peso.

**Seguridad pendiente antes de una instalación real**, en orden de importancia:

1. **HTTPS.** Los tokens y los códigos viajan en claro por la red de la facultad.
2. **Firmar el enlace de radio** (HMAC + contador anti-replay, o ESP-NOW unicast cifrado).
3. **Reemplazar el PIN por el SSO de la facultad.** Los PIN ya se guardan con bcrypt.
4. **Sacar las claves por defecto** (`gw-lora-unraf-2025`, `JWT_SECRET`): que el arranque falle si
   faltan en `.env`. Las credenciales WiFi del firmware ya están fuera del código
   (`firmware/nodo_wifi/main/config_local.h`, en el `.gitignore`).
5. El acceso por código ya tiene límite de intentos fallidos por IP; falta en el login.
