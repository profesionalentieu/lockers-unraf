#!/usr/bin/env python3
"""
Puente entre el backend de lockers y la mesh de AURA (MQTT, contrato v4.1 de la cátedra).

    BAJADA  backend --HTTP/WS--> puente --hw/<hw_id>/command--> raíz --mesh--> hoja del gabinete
    SUBIDA  hoja --mesh--> raíz --hw/<hw_id>/data|response|status--> puente --HTTP--> backend

Reemplaza a gateway_serie.py cuando el gabinete es una hoja de la mesh (firmware/hoja_mesh).
El backend NO cambia: el puente habla la misma API de gateway (/api/gateway/...) que el puente
serie y que la placa WiFi.

Traducciones:

    orden del backend   {"id":12,"nodo":"NODO-A","bit":0,"accion":"ABRIR","ms":15000}
      -> hw/<hw_id>/command
                        {"command":"abrir","params":{"puerta":1,"ms":15000,"id":12},"command_id":"lk-12"}

    hw/<hw_id>/response {"status":"aplicado","details":{"command_id":"lk-12",...}}
      -> POST /api/gateway/comandos/12/ack {"ok":true}

    hw/<hw_id>/data     {"values":{"puerta_1":1,...,"solenoide_1":1,...},"ingest_id":"...","ts":"..."}
      -> POST /api/gateway/telemetria {"nodo":"NODO-A","lecturas":[{"bit":0,"puertaAbierta":true},...]}

    hw/<hw_id>/status   {"status":"online","details":{"rssi":-60,...}}
      -> POST /api/gateway/heartbeat {"nodo":"NODO-A","rssi":-60}

El `hw_id` de cada gabinete es la MAC de su placa (`mac-` + 12 hex). Lo imprime la hoja al
arrancar y lo muestra el tablero de broker.py. Se le pasa al puente con --nodo CODIGO=hw_id.

QUIÉN CONFIRMA LAS MUESTRAS. La hoja guarda cada medición hasta que AURA la confirma con
hw/<hw_id>/ack, y manda de a una: sin ack, las siguientes esperan. El ack lo publica AURA (o
la "AURA falsa" de broker.py en el banco). El puente NO lo publica, salvo con --confirmar, que
es solo para probar con un Mosquitto pelado sin AURA: con AURA andando habría dos ack.

Uso:
    pip install "paho-mqtt>=2.0" requests websocket-client
    python puente_mesh.py --broker 192.168.0.20:1883 --nodo NODO-A=mac-907069add964
    MQTT_USUARIO=... MQTT_CLAVE=... python puente_mesh.py --broker ... --nodo ...   (broker de AURA)
"""

import argparse
import collections
import datetime
import json
import os
import re
import threading
import time
import uuid

import requests

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - mensaje para quien no instaló nada
    raise SystemExit('Falta paho-mqtt:  pip install "paho-mqtt>=2.0" requests websocket-client')

API_KEY = os.environ.get("GATEWAY_API_KEY", "gw-lora-unraf-2025")    # = GATEWAY_API_KEY del backend
INTERVALO_POLL = 1.0            # segundos entre consultas de órdenes (el WebSocket las adelanta)
TIMEOUT_HTTP = 5
HW_ID = re.compile(r"^mac-[0-9a-f]{12}$")
PREFIJO_COMANDO = "lk-"         # command_id = "lk-<id del comando en el backend>"

# Rechazos de la hoja o del raíz que no tiene sentido reintentar: se informan al backend como
# fallidos. Los demás (nodo_no_alcanzable, sin_resultado_del_nodo, puertas_ocupadas) se dejan
# pasar: el backend reintenta solo a los COMANDO_TIMEOUT_SEG y descarta la orden si vence.
RECHAZOS_DEFINITIVOS = {
    "json_invalido", "comando_muy_grande", "comando_desconocido", "el_raiz_no_acepta_comandos",
    "puerta_fuera_de_rango", "ms_fuera_de_rango", "orden_local_no_permitida",
}


def ahora():
    return datetime.datetime.now().strftime("%H:%M:%S")


def log(texto):
    print(f"{ahora()}  {texto}", flush=True)


def leer_ts(texto):
    """ts ISO 8601 en UTC del contrato -> datetime, o None si no vino o no se entiende."""
    if not isinstance(texto, str):
        return None
    try:
        return datetime.datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        return None


class Puente:
    def __init__(self, args):
        self.backend = args.backend.rstrip("/")
        self.max_atraso = args.max_atraso
        self.confirmar = args.confirmar
        self.nodos = {}          # código del nodo -> hw_id
        self.hw = {}             # hw_id -> código del nodo
        for par in args.nodo:
            codigo, _, hw_id = par.partition("=")
            hw_id = hw_id.strip().lower()
            if not codigo or not HW_ID.match(hw_id):
                raise SystemExit(f"--nodo {par!r}: tiene que ser CODIGO=mac-<12 hex>, p. ej. NODO-A=mac-907069add964")
            self.nodos[codigo.strip()] = hw_id
            self.hw[hw_id] = codigo.strip()
        self.rssi = {}                                    # hw_id -> último rssi informado
        self.vistos = collections.OrderedDict()           # ingest_id ya reenviados (reintentos)
        self.corriendo = True
        self._sesiones = threading.local()                # una sesión HTTP por hilo

        host, _, puerto = args.broker.partition(":")
        self.mqtt = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=args.client_id,
            clean_session=False,                          # sesión persistente: no pierde lo QoS 1
            protocol=mqtt.MQTTv311,
        )
        usuario = args.usuario or os.environ.get("MQTT_USUARIO")
        clave = args.clave or os.environ.get("MQTT_CLAVE")
        if usuario:
            self.mqtt.username_pw_set(usuario, clave)
        self.mqtt.reconnect_delay_set(min_delay=1, max_delay=30)
        self.mqtt.on_connect = self.al_conectar
        self.mqtt.on_disconnect = self.al_desconectar
        self.mqtt.on_message = self.al_recibir
        self.broker = (host or "localhost", int(puerto or 1883))

    @property
    def http(self):
        """requests.Session no es segura entre hilos: MQTT, polling y WebSocket usan la suya."""
        sesion = getattr(self._sesiones, "s", None)
        if sesion is None:
            sesion = self._sesiones.s = requests.Session()
            sesion.headers.update({"x-api-key": API_KEY, "Content-Type": "application/json"})
        return sesion

    # ------------------------------------------------------------------ MQTT
    def al_conectar(self, cliente, _userdata, _flags, codigo, _props):
        if codigo.is_failure:
            log(f"[mqtt] el broker rechazó la conexión: {codigo}")
            return
        topicos = []
        for hw_id in self.hw:
            for sub in ("data", "response", "status", "alerts/+"):
                topicos.append((f"hw/{hw_id}/{sub}", 1))
        cliente.subscribe(topicos)
        log(f"[mqtt] conectado a {self.broker[0]}:{self.broker[1]}, escuchando {len(self.hw)} gabinete(s)")

    def al_desconectar(self, _cliente, _userdata, _flags, codigo, _props):
        if self.corriendo:
            log(f"[mqtt] desconectado ({codigo}); reintenta solo")

    def al_recibir(self, _cliente, _userdata, msg):
        partes = msg.topic.split("/")
        if len(partes) < 3 or partes[1] not in self.hw:
            return
        hw_id, tipo = partes[1], "/".join(partes[2:])
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log(f"[mqtt] {msg.topic}: payload que no es JSON, descartado")
            return
        if not isinstance(payload, dict):
            return
        try:
            if tipo == "data":
                self.subir_data(hw_id, payload)
            elif tipo == "response":
                self.subir_respuesta(hw_id, payload)
            elif tipo == "status":
                self.subir_status(hw_id, payload)
            elif tipo.startswith("alerts/"):
                d = payload.get("details") or {}
                log(f"<- ALERTA {self.hw[hw_id]} {tipo[7:]} [{payload.get('severity')}] "
                    f"{payload.get('message')} {json.dumps(d, ensure_ascii=False)}")
        except requests.RequestException as e:
            # Backend caído: lo próximo que mande la hoja (cambio o medición periódica) resincroniza
            log(f"[backend] no pude reenviar {msg.topic}: {e}")

    # ------------------------------------------------------------------ SUBIDA
    def subir_data(self, hw_id, payload):
        nodo = self.hw[hw_id]
        ingest_id = payload.get("ingest_id")
        if self.confirmar and ingest_id:
            self.mqtt.publish(f"hw/{hw_id}/ack", json.dumps({"ingest_id": ingest_id, "resultado": "persistido"}), qos=1)
        if ingest_id:
            if ingest_id in self.vistos:
                return                                    # reintento de una muestra ya reenviada
            self.vistos[ingest_id] = True
            while len(self.vistos) > 1000:
                self.vistos.popitem(last=False)

        values = payload.get("values")
        if not isinstance(values, dict):
            return
        ts = leer_ts(payload.get("ts"))
        if ts is not None and self.max_atraso > 0:
            atraso = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds()
            if atraso > self.max_atraso:
                # Muestra guardada en la hoja durante un corte. AURA la registra igual, pero
                # reproducir aperturas viejas haría saltar alertas de operaciones ya cerradas:
                # el estado real llega con la medición siguiente.
                log(f"<- {nodo}: muestra de hace {atraso:.0f} s, no se reenvía al backend")
                return

        lecturas = []
        for clave, valor in values.items():
            m = re.fullmatch(r"puerta_(\d+)", clave)
            if m and isinstance(valor, (int, float, bool)):
                lecturas.append({"bit": int(m.group(1)) - 1, "puertaAbierta": bool(valor)})
        if not lecturas:
            return
        lecturas.sort(key=lambda l: l["bit"])
        self.http.post(
            f"{self.backend}/api/gateway/telemetria",
            json={"nodo": nodo, "lecturas": lecturas, "rssi": self.rssi.get(hw_id)},
            timeout=TIMEOUT_HTTP,
        )
        abiertas = [str(l["bit"] + 1) for l in lecturas if l["puertaAbierta"]]
        energizados = [k[10:] for k, v in values.items() if k.startswith("solenoide_") and v]
        log(f"<- {nodo}: abiertas [{','.join(abiertas) or '-'}] energizados [{','.join(energizados) or '-'}]")

    def subir_respuesta(self, hw_id, payload):
        estado = payload.get("status")
        detalles = payload.get("details") or {}
        command_id = str(detalles.get("command_id") or "")
        if not command_id.startswith(PREFIJO_COMANDO):
            return                                        # un comando de AURA, no nuestro
        try:
            id_comando = int(command_id[len(PREFIJO_COMANDO):])
        except ValueError:
            return
        motivo = detalles.get("motivo")
        if estado == "aplicado":
            r = self.http.post(f"{self.backend}/api/gateway/comandos/{id_comando}/ack",
                               json={"ok": True}, timeout=TIMEOUT_HTTP)
            log(f"<- ACK comando {id_comando} ({self.hw[hw_id]}) -> {r.status_code}")
        elif estado == "rechazado" and motivo in RECHAZOS_DEFINITIVOS:
            self.http.post(f"{self.backend}/api/gateway/comandos/{id_comando}/ack",
                           json={"ok": False, "detalle": f"Rechazado por la hoja: {motivo}"},
                           timeout=TIMEOUT_HTTP)
            log(f"<- comando {id_comando} RECHAZADO ({motivo}): el backend lo marca fallido")
        elif estado == "rechazado":
            log(f"<- comando {id_comando} rechazado ({motivo}): el backend lo reintenta o lo vence")
        else:
            log(f"<- comando {id_comando}: {estado}")

    def subir_status(self, hw_id, payload):
        nodo = self.hw[hw_id]
        detalles = payload.get("details") or {}
        if payload.get("status") == "online":
            if isinstance(detalles.get("rssi"), (int, float)):
                self.rssi[hw_id] = detalles["rssi"]
            self.http.post(f"{self.backend}/api/gateway/heartbeat",
                           json={"nodo": nodo, "rssi": self.rssi.get(hw_id)}, timeout=TIMEOUT_HTTP)
            config = detalles.get("config") or {}
            if detalles.get("evento") == "reporte":
                log(f"<- {nodo} online: modo {detalles.get('modo')}, aula {config.get('aula')}, "
                    f"rssi {detalles.get('rssi')}, capa {detalles.get('capa')}, pendientes {detalles.get('pendientes')}")
        else:
            # El backend lo marca desconectado solo, a los NODO_OFFLINE_SEG sin noticias
            log(f"<- {nodo} OFFLINE ({detalles.get('motivo', 'sin motivo')})")

    # ------------------------------------------------------------------ BAJADA
    def transmitir(self, orden):
        """Una orden del backend -> comando MQTT a la hoja del gabinete."""
        id_comando = orden["id"]
        hw_id = self.nodos.get(orden.get("nodo"))
        if hw_id is None:
            log(f"[bajada] el nodo {orden.get('nodo')!r} no tiene hw_id (falta --nodo {orden.get('nodo')}=mac-...)")
            self.http.post(f"{self.backend}/api/gateway/comandos/{id_comando}/ack",
                           json={"ok": False, "detalle": "El puente no conoce la placa de ese nodo"},
                           timeout=TIMEOUT_HTTP)
            return
        if orden.get("accion") != "ABRIR":
            self.http.post(f"{self.backend}/api/gateway/comandos/{id_comando}/ack",
                           json={"ok": False, "detalle": f"La hoja no acepta {orden.get('accion')}"},
                           timeout=TIMEOUT_HTTP)
            return
        comando = {
            "command": "abrir",
            "params": {"puerta": int(orden["bit"]) + 1, "ms": int(orden.get("ms") or 15000), "id": id_comando},
            "command_id": f"{PREFIJO_COMANDO}{id_comando}",
        }
        texto = json.dumps(comando, separators=(",", ":"))
        self.mqtt.publish(f"hw/{hw_id}/command", texto, qos=1)
        log(f"-> {orden.get('nodo')} puerta {comando['params']['puerta']} ABRIR {comando['params']['ms']} ms "
            f"(comando {id_comando}, motivo {orden.get('motivo')})")

    def bucle_polling(self):
        """Camino confiable: aunque se caiga el WebSocket, toma las órdenes cada segundo."""
        while self.corriendo:
            try:
                r = self.http.get(f"{self.backend}/api/gateway/comandos", timeout=TIMEOUT_HTTP)
                for orden in r.json().get("comandos", []):
                    self.transmitir(orden)
            except (requests.RequestException, ValueError) as e:
                log(f"[poll] sin backend: {e}")
                time.sleep(4)
            time.sleep(INTERVALO_POLL)

    def bucle_websocket(self):
        """Camino rápido: el backend avisa la orden apenas se valida el código.
        La orden se transmite igual cuando la entrega el polling (que la marca enviada)."""
        try:
            import websocket  # websocket-client
        except ImportError:
            log("[ws] websocket-client no instalado: solo polling (hasta 1 s más de demora)")
            return
        url = self.backend.replace("http", "ws", 1) + f"/ws?apiKey={API_KEY}"

        def al_mensaje(_ws, mensaje):
            try:
                datos = json.loads(mensaje)
            except ValueError:
                return
            if datos.get("evento") == "comando.nuevo":
                self.despertar.set()

        while self.corriendo:
            try:
                websocket.WebSocketApp(url, on_message=al_mensaje).run_forever()
            except Exception as e:  # noqa: BLE001 - cualquier falla: reintentar
                log(f"[ws] reconectando: {e}")
            time.sleep(5)

    def bucle_polling_rapido(self):
        """Consulta en el acto cuando el WebSocket avisa una orden nueva."""
        while self.corriendo:
            if self.despertar.wait(timeout=1):
                self.despertar.clear()
                try:
                    r = self.http.get(f"{self.backend}/api/gateway/comandos", timeout=TIMEOUT_HTTP)
                    for orden in r.json().get("comandos", []):
                        self.transmitir(orden)
                except (requests.RequestException, ValueError) as e:
                    log(f"[ws] no pude pedir la orden: {e}")

    # ------------------------------------------------------------------
    def arrancar(self):
        self.despertar = threading.Event()
        self.mqtt.connect_async(*self.broker, keepalive=30)
        self.mqtt.loop_start()
        for destino in (self.bucle_polling, self.bucle_websocket, self.bucle_polling_rapido):
            threading.Thread(target=destino, daemon=True).start()
        log("Puente mesh en marcha: " + ", ".join(f"{c} = {h}" for c, h in self.nodos.items()))
        if self.confirmar:
            log("ATENCIÓN: --confirmar publica los ack de AURA. Solo para un broker sin AURA.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            self.corriendo = False
            self.mqtt.loop_stop()
            self.mqtt.disconnect()
            log("Puente cerrado")


def main():
    p = argparse.ArgumentParser(description="Puente mesh de AURA (MQTT) <-> backend de lockers")
    p.add_argument("--broker", default=os.environ.get("MQTT_BROKER", "localhost:1883"),
                   help="host:puerto del broker MQTT de AURA (o de broker.py en el banco)")
    p.add_argument("--usuario", help="usuario MQTT (o MQTT_USUARIO); broker.py no pide")
    p.add_argument("--clave", help="clave MQTT (o MQTT_CLAVE)")
    p.add_argument("--backend", default=os.environ.get("BACKEND_URL", "http://localhost:3000"))
    p.add_argument("--nodo", action="append", default=[], metavar="CODIGO=mac-xxxxxxxxxxxx",
                   help="código del nodo en el backend y hw_id de su placa (se repite por gabinete)")
    p.add_argument("--max-atraso", type=float, default=60,
                   help="segundos: una muestra más vieja que esto no se reenvía al backend (0 = todas)")
    p.add_argument("--client-id", default="lockers-puente-" + uuid.getnode().to_bytes(6, "big").hex()[-6:],
                   help="client_id MQTT fijo (sesión persistente)")
    p.add_argument("--confirmar", action="store_true",
                   help="publicar el ack de cada muestra (SOLO con un broker sin AURA)")
    args = p.parse_args()
    if not args.nodo:
        p.error("falta al menos un --nodo CODIGO=mac-..., p. ej. --nodo NODO-A=mac-907069add964")
    Puente(args).arrancar()


if __name__ == "__main__":
    main()
