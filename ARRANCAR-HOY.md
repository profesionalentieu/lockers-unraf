# Arrancar hoy — guía paso a paso

De cero a sistema funcionando en unos 25 minutos, sin hardware.
Al final vas a tener el servidor corriendo, los tres frontends (app, pantalla del locker y Alumnado) contra ese servidor, y un nodo
simulado abriendo y cerrando puertas de verdad en el tablero.

Los comandos están para Windows y para Mac/Linux. Donde no aclaro nada, son iguales en los dos.

---

## Antes de empezar: qué vas a tener abierto

Al final del proceso vas a tener **tres ventanas de terminal abiertas al mismo tiempo**:

| Terminal | Qué corre | Se puede cerrar |
|---|---|---|
| 1 | El servidor (`npm start`) | No, mientras uses el sistema |
| 2 | El simulador del nodo | Sí, pero entonces las puertas no se abren |
| 3 | Comandos sueltos | Sí |

Es normal que las dos primeras queden "colgadas" mostrando mensajes: eso significa que están
funcionando. Se cierran con `Ctrl+C`.

---

## Paso 1 — Instalar Node.js

Andá a **nodejs.org** y bajá la versión **LTS** (el botón de la izquierda, dice algo como
"20.x.x LTS" o superior).

El proyecto **no tiene dependencias nativas**: usa el SQLite que Node trae incluido
(`node:sqlite`). Así que no hace falta compilador ni herramientas extra, y el checkbox
*"Tools for Native Modules"* que aparece durante la instalación podés dejarlo como venga.

Necesitás **Node 22.5 o superior**. Si tenés uno más viejo, el proyecto igual funciona: cae
automáticamente en la librería `better-sqlite3`, pero ahí sí vas a necesitar el compilador.

**Verificá que quedó bien.** Abrí una terminal:

- Windows: tecla Windows → escribí `powershell` → Enter
- Mac: Spotlight (Cmd+Espacio) → `Terminal`
- Linux: Ctrl+Alt+T

Escribí:

```bash
node -v
```

Tiene que responder algo como `v20.11.0`. Si dice "no se reconoce el comando" o "command not
found", cerrá la terminal, abrí una nueva y probá otra vez (el instalador no actualiza las
terminales que ya estaban abiertas). Si sigue igual, Node no quedó instalado.

---

## Paso 2 — Descomprimir el proyecto

Bajá `panol-unraf.zip` y descomprimilo. **Importante: descomprimilo de verdad**, no lo abras desde
adentro del zip — en Windows se puede navegar un zip como si fuera una carpeta, pero los comandos
no funcionan ahí.

Dejalo en un lugar de ruta corta y sin espacios ni acentos, por ejemplo:

- Windows: `C:\panol`
- Mac/Linux: `~/panol`

Adentro tenés que ver la carpeta `lockers-unraf` con `backend`, `frontend`, `gateway` y `firmware`.

---

## Paso 3 — Abrir la terminal en la carpeta correcta

Este paso es el que más confusión genera. Todos los comandos que siguen se corren **parado en la
carpeta `backend`**.

**Windows (la forma fácil):** abrí el Explorador, entrá a `C:\panol\lockers-unraf\backend`, hacé
clic derecho en un espacio vacío de la ventana y elegí *"Abrir en Terminal"* (en Windows 10 puede
decir *"Abrir ventana de PowerShell aquí"*, a veces con Shift + clic derecho).

**Cualquier sistema:** desde una terminal ya abierta,

```bash
cd C:\panol\lockers-unraf\backend      # Windows
cd ~/panol/lockers-unraf/backend       # Mac / Linux
```

**Verificá que estás bien parado:**

```bash
dir        # Windows
ls         # Mac / Linux
```

Tenés que ver `package.json` y la carpeta `src`. Si no los ves, estás en otra carpeta.

---

## Paso 4 — Crear el archivo de configuración

```bash
copy .env.example .env     # Windows
cp .env.example .env       # Mac / Linux
```

No devuelve nada, o dice "1 archivo copiado". Para probar en tu máquina podés dejar el contenido
tal cual está; cuando lo instalen en la facultad hay que cambiar `JWT_SECRET` y `GATEWAY_API_KEY`.

Si el archivo no existe, el servidor igual arranca con valores por defecto, pero mejor tenerlo.

---

## Paso 5 — Instalar las dependencias

```bash
npm install
```

Tarda **uno a tres minutos** la primera vez y escupe bastante texto. Es normal que aparezcan
mensajes amarillos de `npm warn`: eso no es un error. Terminó bien si al final dice algo como
`added 87 packages`.

**Si falla**:

| Lo que dice | Qué hacer |
|---|---|
| `npm : No se puede cargar el archivo ... npm.ps1 porque la ejecución de scripts está deshabilitada` | PowerShell bloquea los scripts por defecto. Usá `npm.cmd install` en lugar de `npm install` (y `npm.cmd` en todos los pasos siguientes). O abrí CMD en vez de PowerShell, donde no existe esa restricción. |
| `EACCES` o permisos (Mac/Linux) | Estás en una carpeta del sistema. Movelo a tu carpeta personal (`~/panol`). |
| Avisos `npm warn deprecated` o `allow-scripts` | No son errores. Como el proyecto ya no depende de better-sqlite3, podés ignorarlos. |

---

## Paso 6 — Crear la base de datos

```bash
npm run seed
```

Tiene que responder algo así:

```
[19:12:04] INFO  Base SQLite lista: .../backend/data/lockers.db
[19:12:04] INFO  Pañol cargado:
[19:12:04] INFO    Alumnado -> usuario: alumnado / clave: unraf2025
[19:12:04] INFO    Alumno   -> legajo: 10234 / PIN: 4821   (1 unidad, solo hoy, siempre con aprobación)
[19:12:04] INFO    Alumno   -> legajo: 10235 / PIN: 7390
[19:12:04] INFO    Docente  -> legajo: 20011 / PIN: 1145   (hasta 7 días; aprobación si pide > 50%)
[19:12:04] INFO    Docente  -> legajo: 20012 / PIN: 2468
[19:12:04] INFO    A-01 25 notebooks | A-02 10 zapatillas | A-03 50 fibrones | A-04 12 kits Arduino
```

Esto crea el archivo `backend/data/lockers.db` con los 4 lockers, su material y las personas de
prueba. Los PIN quedan guardados cifrados (bcrypt): si te olvidás cuál era, `npm run verificar`
muestra los del seed.

> **Si ya habías corrido una versión anterior del proyecto** (la v3 cambió el esquema a v4), borrá la carpeta `backend/data`
> entera antes de este paso — no solo el archivo `lockers.db`, porque al lado quedan `lockers.db-wal`
> y `lockers.db-shm`:
>
> ```powershell
> Remove-Item -Recurse -Force data     # Windows
> rm -rf data                          # Mac / Linux
> ```
>
> Si te olvidás, el sistema te lo dice con un mensaje que explica exactamente qué hacer: el código
> lleva un número de versión de esquema y compara contra el de la base.

Este comando se corre **una sola vez**. Si lo corrés de nuevo no rompe nada (no duplica datos),
pero tampoco hace falta.

---

## Paso 7 — Levantar el servidor

```bash
npm start
```

Tiene que quedar así, y **quedarse ahí**:

```
[19:14:22] INFO  Base SQLite lista: .../backend/data/lockers.db
[19:14:22] INFO  WebSocket escuchando en /ws
[19:14:22] INFO  Watchdog activo cada 5000 ms
[19:14:22] INFO  API      -> http://localhost:3000/api
[19:14:22] INFO  Alumnado -> http://localhost:3000/admin
[19:14:22] INFO  Usuarios -> http://localhost:3000/
[19:14:22] INFO  Puertas  -> http://localhost:3000/locker/A-01  (destino de los QR)
```

**No cierres esta ventana.** Mientras esté abierta, el sistema está prendido. Si la cerrás o hacés
`Ctrl+C`, se apaga todo.

**Si dice `EADDRINUSE`**, el puerto 3000 ya está ocupado por otro programa. O cerrás ese programa,
o cambiás el puerto: abrí `.env` y poné `PORT=3001` (después usá 3001 en todas las direcciones).

---

## Paso 8 — Prender el nodo simulado

El simulador hace de gateway, de placa y de **la persona frente a la puerta**: cuando llega una
orden de apertura, "energiza" el solenoide 15 s, a los 2-5 s "tira de la puerta" y unos segundos
después la cierra. No necesitás instalar nada. En una **terminal nueva** (no cierres la del servidor),
parado en la carpeta del proyecto, la de arriba de `backend`:

```bash
node gateway/simulador_nodo.js
```

> `arrancar.bat` / `arrancar.sh` hacen los pasos 7 y 8 juntos y abren el navegador.

---

## Paso 9 — Entrar por primera vez

Abrí **http://localhost:3000/admin** y entrá con `alumnado` / `unraf2025`. Vas a ver el gabinete con
las 4 puertas y su stock (25 notebooks, 10 zapatillas, 50 fibrones, 12 kits) y la cola de
solicitudes vacía.

En **otra pestaña** (o mejor, con la ventana angosta, como un celular) abrí **http://localhost:3000/**
y entrá como docente: `20011` / `1145`.

---

## Paso 10 — El circuito completo, como lo pide la especificación

1. **Reserva automática (docente ≤ 50%).** Elegí *Hoy*, la hora más próxima y *1 h*. En las
   notebooks poné **5** y tocá **Reservar**: aparece el **código de 6 dígitos** y el locker A-01. No
   pasó por Alumnado porque 5 no supera el 50% de 25.
2. **Retiro frente a la puerta.** Abrí **http://localhost:3000/locker/A-01** (es lo que abre el QR
   pegado en la puerta) e ingresá el código. Vas a ver la cuenta regresiva de 15 s; a los pocos
   segundos el simulador "abre" la puerta (*Retirá 5 × Notebook*), y al cerrarla dice **Retiro
   registrado**. En Alumnado, A-01 muestra 5 en uso.
3. **Devolución estándar (camino A).** En la app, *Mis reservas* → **Iniciar devolución**. Te lleva
   a la pantalla del locker, la puerta se abre y se cierra: queda en *Devuelto* y las unidades vuelven
   al stock a los 30 minutos (buffer), sin que Alumnado haga nada.
4. **Alumno con aprobación.** Salí y entrá como alumno `10234` / `4821`. Solicitá 1 fibrón: queda
   *En revisión*. En Alumnado aparece arriba con un aviso sonoro → **Aprobar**. Al alumno le aparece
   su código al instante.
5. **Devolución crítica (camino B).** Retirá y devolvé ese fibrón en `/locker/A-03`. Como es alumno,
   en Alumnado aparece la alerta amarilla **"Verificar reingreso físico en Locker A-03"**: hasta que
   tocás **Confirmar Stock OK**, esa unidad no vuelve a estar disponible.
6. **Trazabilidad.** Solapa *Reservas y préstamos* → *Detalle*: cada pulso, apertura y cierre con
   legajo y hora. La bitácora del panel mezcla decisiones y eventos físicos.

---

## Paso 11 — Desde el celular

Averiguá la IP de la PC:

```bash
ipconfig       # Windows -> buscá "Dirección IPv4", ej: 192.168.0.15
ifconfig       # Mac
ip addr        # Linux
```

Desde el celular, **conectado al mismo WiFi**, abrí `http://192.168.0.15:3000` (con tu IP). Entrá
con el legajo 10234 y pedí material: lo vas a ver aparecer en la pantalla de la PC al instante.

**Los QR de las puertas:** en Alumnado, *Imprimir los QR de las puertas* abre una hoja con los 4
carteles. Escribí arriba la IP de la PC (no `localhost`: el QR lo lee un celular), imprimila y pegá
cada cartel en su puerta. Escanear el de A-01 abre `http://192.168.0.15:3000/locker/A-01`.

**Si no carga**, es el firewall. En Windows: Panel de control → Firewall → "Permitir una aplicación
a través del Firewall" → buscá Node.js y tildá "Privada". Como prueba rápida podés desactivar el
firewall un minuto para confirmar que el problema es ese; si con eso anda, volvé a prenderlo y creá
la excepción.

---

## Ensayar los escenarios de falla

Los que conviene tener practicados para la defensa. Cortá el simulador con `Ctrl+C` y volvé a
arrancarlo con la opción que corresponda:

```bash
node gateway/simulador_nodo.js --no-abre A-02
```
**Puerta trabada al abrir (Fase 2.4).** Reservá zapatillas y validá el código en `/locker/A-02`:
nadie tira de la puerta, a los 15 s la pantalla dice *No detectamos la apertura* y ofrece
**Reintentar apertura**. La reserva no se pierde aunque pasen los 15 minutos de tolerancia.

```bash
node gateway/simulador_nodo.js --cierre 50
```
**Puerta mal cerrada (45 s).** La puerta queda abierta 50 s: a los 45 el celular suena, vibra y
muestra *"¡Atención! Puerta del Locker A-0X mal cerrada…"*, y la alerta aparece en rojo en el panel.
Con `--trabar A-04` no se cierra nunca y a los 120 s el locker pasa a *Trabado / Error* (se repone
con *Dar de alta*).

**Faltante.** Con la puerta abierta, tocá **Reportar faltante / incidencia**. En el panel aparece
quién reportó y el **presunto responsable**: el último legajo que cerró ese locker.

**No-show.** Reservá para la hora actual y no hagas nada: a los 15 minutos la reserva pasa a
*No retirado* y las unidades se liberan solas.

**Mora y sanción.** Reservá 1 h, retirá y no devuelvas: a la hora límite pasa a **En mora**, el
legajo queda sancionado (no puede reservar) y la fila aparece en rojo con los minutos de demora.
Se resuelve con *Devolución en ventanilla* o devolviendo en el locker (va a auditoría) y después
*Rehabilitar* en *Personas*. Para no esperar una hora, `npm test` recorre todos estos casos con el
reloj adelantado.

```bash
node gateway/simulador_nodo.js --perder 40
```
**Radio con pérdida de órdenes.** Vas a ver `~ orden #N PERDIDA en el aire` y, unos segundos
después, la misma orden de nuevo: son los reintentos automáticos.

---

## Resumen para tenerlo a mano

**Los pasos 1 a 6 son de instalación: se hacen una sola vez.** La base de datos queda creada y los
datos se conservan entre sesiones, así que `npm run seed` no se repite (solo si querés volver todo
al estado inicial).

La forma más rápida de arrancar todos los días es hacer **doble clic en `arrancar.bat`** (Windows)
o correr `./arrancar.sh` (Mac/Linux), que está en la raíz del proyecto: levanta el servidor, el
nodo simulado y abre las dos pestañas del navegador.

A mano son dos comandos en dos terminales:

```bash
# Terminal 1
cd C:\panol\lockers-unraf\backend
npm start

# Terminal 2
cd C:\panol\lockers-unraf
node gateway/simulador_nodo.js
```

Y el navegador en `http://localhost:3000/admin`, `http://localhost:3000/` y `http://localhost:3000/locker/A-01`.

---

## Si algo no anda

| Síntoma | Causa más probable |
|---|---|
| "No hay conexión con el servidor del pañol" | El servidor no está corriendo, o abriste el HTML como archivo (`file://`) en vez de `http://localhost:3000` |
| La pantalla del locker se queda en "Enviando la orden" | El simulador (o el gateway / la placa) no está prendido |
| "Código inválido o vencido" | El código es de otra reserva, ya se usó para devolver, o pasaron los 15 min de tolerancia |
| "Tu retiro se habilita a las HH:MM" | Todavía no empezó la franja: el código sirve desde la hora de inicio |
| "Demasiados códigos incorrectos" | 8 códigos mal en 5 minutos desde el mismo dispositivo: esperá unos minutos |
| El QR abre `localhost` en el celular | Imprimiste la hoja con `localhost`: volvé a generarla con la IP de la PC |
| `npm no se reconoce` | Node no está instalado, o la terminal es vieja: abrí una nueva |
| `npm.ps1 ... ejecución de scripts está deshabilitada` | Usá `npm.cmd` en vez de `npm`, o abrí CMD en lugar de PowerShell |
| `Assertion failed: (env) != nullptr` con un stack trace nativo | Versión vieja del proyecto con better-sqlite3 incompatible con tu Node. Actualizá al paquete nuevo: ya no usa librerías nativas. |
| `Cannot find module` | Faltó `npm install`, o lo corriste parado en otra carpeta |
| `no such table` | Faltó `npm run seed` |
| "La base de datos es de una versión anterior" | Borrá la carpeta `backend/data` entera y volvé a sembrar |
| `no such column: ...` | Base vieja de antes del control de versión: `Remove-Item -Recurse -Force data` y `npm.cmd run seed` |
| `EADDRINUSE` | El puerto 3000 está ocupado: cambiá `PORT` en `.env` |
| El celular no abre la página | Firewall de la PC, o no están en la misma red WiFi |
| El simulador dice "el backend no responde" | La terminal 1 se cerró, o usaste otro puerto |
| `pip no se reconoce` | Usá el simulador de Node (`node gateway/simulador_nodo.js`), que no necesita instalar nada. Si querés el de Python: `python -m pip install requests` |
