#!/usr/bin/env python3
"""
Simulador de la hoja de la mesh del gabinete (firmware/hoja_mesh), visto desde MQTT.

Hace lo que publicaría el raíz de la mesh de AURA por una hoja de lockers, sin ninguna placa:
recibe hw/<hw_id>/command, contesta transmitido -> recibido -> aplicado/rechazado como el raíz,
energiza el "solenoide", simula a la persona que abre y cierra la puerta, y publica las
mediciones en hw/<hw_id>/data con su ingest_id, de a una y hasta que llegue el ack (como la
cola de la hoja). Valida los comandos y set_config con las mismas reglas que el firmware.

Sirve para probar toda la cadena en una PC:

    python broker.py                                   (aura-firmware/Mesh_Red_Completa/Broker_MQTT)
    npm start                                          (backend/)
    python gateway/simulador_hoja_mesh.py              (esta hoja falsa: imprime su hw_id)
    python gateway/puente_mesh.py --nodo NODO-A=mac-5a0000000a01

y validar un código en http://localhost:3000/locker/A-01.

Para ensayar las fallas:
    --no-abre 2       nadie abre la puerta 2: el backend ofrece "Reintentar apertura"
    --trabar 4        la puerta 4 queda abierta: alerta a los 45 s en el backend
    --cierre 50       la persona cierra a los 50 s
    --forzar 3        a los 10 s alguien abre la puerta 3 sin orden (alerta apertura_sin_orden)
    --sin-aula        la hoja todavía no tiene aula (modo sin_aula, como recién grabada)

Uso:  pip install "paho-mqtt>=2.0"
      python simulador_hoja_mesh.py [--broker localhost:1883] [--hw mac-5a0000000a01]
"""

import argparse
import collections
import datetime
import json
import re
import threading
import time
import uuid

import paho.mqtt.client as mqtt

CANT_PUERTAS = 4
RAIZ = "mac-5a00000000aa"            # hw_id del raíz falso: va en "adaptador"
AULA_VALIDA = re.compile(r"^[a-z0-9_-]{1,15}$")


def ahora():
    return datetime.datetime.now().strftime("%H:%M:%S")


def log(texto):
    print(f"{ahora()}  {texto}", flush=True)


def ts_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class HojaFalsa:
    def __init__(self, args):
        self.hw = args.hw
        self.args = args
        self.abierta = [False] * CANT_PUERTAS
        self.hasta = [0.0] * CANT_PUERTAS                # fin del pulso de cada solenoide
        self.config = {"aula": None if args.sin_aula else "panol", "intervalo_s": 30,
                       "max_abierta_s": 120, "puertas": CANT_PUERTAS}
        self.cola = collections.deque(maxlen=400)        # muestras sin confirmar
        self.en_vuelo = None
        self.enviada_en = 0.0
        self.espera = 15.0
        self.lock = threading.RLock()
        self.medir_ya = threading.Event()

        host, _, puerto = args.broker.partition(":")
        self.mqtt = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"sim-{self.hw}")
        # Como el raíz: si la "hoja" se cae, AURA la ve offline
        self.mqtt.will_set(f"hw/{self.hw}/status",
                           json.dumps({"status": "offline", "details": {"motivo": "sin_tramas"}}), qos=1, retain=True)
        self.mqtt.on_connect = self.al_conectar
        self.mqtt.on_message = self.al_recibir
        self.broker = (host or "localhost", int(puerto or 1883))

    # ------------------------------------------------------------------ MQTT
    def al_conectar(self, cliente, *_):
        cliente.subscribe([(f"hw/{self.hw}/command", 1), (f"hw/{self.hw}/ack", 1)])
        self.reportar()
        log(f"[mqtt] conectado; hoja {self.hw}")

    def publicar(self, sub, payload, retener=False):
        self.mqtt.publish(f"hw/{self.hw}/{sub}", json.dumps(payload, separators=(",", ":")), qos=1, retain=retener)

    def al_recibir(self, _c, _u, msg):
        try:
            datos = json.loads(msg.payload)
        except ValueError:
            datos = None
        if msg.topic.endswith("/ack"):
            self.confirmar(datos or {})
        elif msg.topic.endswith("/command"):
            self.comando(msg.payload, datos)

    # ------------------------------------------------------------------ comandos
    def responder(self, command_id, estado, motivo=None, con_config=False):
        detalles = {}
        if command_id:
            detalles["command_id"] = command_id
        if motivo:
            detalles["motivo"] = motivo
        if con_config:
            detalles["config"] = dict(self.config)
        self.publicar("response", {"status": estado, "details": detalles})

    def comando(self, crudo, datos):
        # Lo que hace el raíz antes de mandarlo por la mesh (contrato §3.3)
        if not isinstance(datos, dict) or not isinstance(datos.get("command"), str):
            self.responder(None, "rechazado", "json_invalido")
            return
        command_id = datos.get("command_id")
        if len(crudo) > 180:
            self.responder(command_id, "rechazado", "comando_muy_grande")
            return
        self.responder(command_id, "transmitido")
        time.sleep(0.03)                                 # ida por la mesh (29-51 ms en el banco)
        ok, motivo = self.ejecutar(datos.get("command"), datos.get("params") or {},
                                   datos.get("origen") == "local")
        if datos.get("origen") == "local":
            return                                       # a una orden local no se le contesta a AURA
        self.responder(command_id, "recibido")
        if ok:
            self.responder(command_id, "aplicado", con_config=True)
        else:
            self.responder(command_id, "rechazado", motivo, con_config=True)

    def ejecutar(self, comando, params, local):
        """Mismas reglas que ejecutar_comando() y aplicar_config() de firmware/hoja_mesh."""
        if comando == "set_config":
            permitidos = {"aula", "intervalo_s", "max_abierta_s"}
            if any(k not in permitidos for k in params):
                return False, "parametro_desconocido"
            if "aula" in params and not (isinstance(params["aula"], str) and AULA_VALIDA.match(params["aula"])):
                return False, "aula_invalida"
            for clave, (lo, hi) in {"intervalo_s": (5, 3600), "max_abierta_s": (30, 3600)}.items():
                v = params.get(clave)
                if v is not None and not (isinstance(v, int) and lo <= v <= hi):
                    return False, f"{clave}_fuera_de_rango"
            self.config.update(params)
            log(f"set_config aplicado: {self.config}")
            self.reportar()
            self.medir_ya.set()
            return True, None
        if comando != "abrir":
            return False, "comando_desconocido"
        if local:
            return False, "orden_local_no_permitida"
        puerta, ms = params.get("puerta"), params.get("ms", 15000)
        if not isinstance(puerta, int) or not 1 <= puerta <= CANT_PUERTAS:
            return False, "puerta_fuera_de_rango"
        if not isinstance(ms, (int, float)) or not 100 <= ms <= 20000:
            return False, "ms_fuera_de_rango"
        i = puerta - 1
        with self.lock:
            nuevo = self.hasta[i] < time.time()
            self.hasta[i] = time.time() + ms / 1000.0    # una orden repetida extiende el pulso
        log(f"ABRIR puerta {puerta} {ms} ms {'(extiende el pulso)' if not nuevo else ''}")
        self.medir_ya.set()
        if nuevo and puerta not in self.args.no_abre:
            threading.Thread(target=self.persona, args=(i,), daemon=True).start()
        return True, None

    def persona(self, i):
        """Alguien tira de la puerta al rato de energizarse y la cierra después."""
        time.sleep(self.args.demora)
        with self.lock:
            if self.hasta[i] < time.time():
                return                                   # llegó tarde: el solenoide ya trabó
            self.abierta[i] = True
        log(f"   la persona ABRE la puerta {i + 1}")
        self.medir_ya.set()
        if i + 1 in self.args.trabar:
            log(f"   la puerta {i + 1} queda trabada abierta")
            return
        time.sleep(self.args.cierre)
        with self.lock:
            self.abierta[i] = False
        log(f"   la persona CIERRA la puerta {i + 1}")
        self.medir_ya.set()

    def forzar(self, puerta):
        time.sleep(10)
        log(f"   ALGUIEN FUERZA la puerta {puerta}")
        with self.lock:
            self.abierta[puerta - 1] = True
        self.medir_ya.set()
        self.publicar("alerts/puerta", {"severity": "high", "message": f"Puerta {puerta} abierta sin orden",
                                        "details": {"puerta": puerta, "motivo": "apertura_sin_orden"}, "ts": ts_utc()})
        time.sleep(6)
        with self.lock:
            self.abierta[puerta - 1] = False
        self.medir_ya.set()
        self.publicar("alerts/puerta", {"severity": "info", "message": f"Puerta {puerta} cerrada",
                                        "details": {"puerta": puerta, "motivo": "cerrada"}, "ts": ts_utc()})

    # ------------------------------------------------------------------ mediciones
    def reportar(self):
        self.publicar("status", {"status": "online", "details": {
            "evento": "reporte", "transporte": "mesh", "config": dict(self.config),
            "pendientes": len(self.cola), "descartadas": 0, "alimentacion": "red",
            "modo": "aula" if self.config.get("aula") else "sin_aula", "rssi": -58, "capa": 3}}, retener=True)

    def medir(self):
        ahora_s = time.time()
        with self.lock:
            values = {f"puerta_{i + 1}": int(self.abierta[i]) for i in range(CANT_PUERTAS)}
            values.update({f"solenoide_{i + 1}": int(self.hasta[i] > ahora_s) for i in range(CANT_PUERTAS)})
            self.cola.append({"values": values, "ingest_id": str(uuid.uuid4()), "ts": ts_utc(), "adaptador": RAIZ})
        self.enviar()

    def enviar(self, reintento=False):
        """De a una muestra, la más vieja, hasta que AURA la confirme (como la cola de la hoja)."""
        with self.lock:
            if not self.cola:
                return
            if self.en_vuelo is not None and not reintento:
                return
            self.en_vuelo = self.cola[0]
            self.enviada_en = time.time()
        self.publicar("data", self.en_vuelo)

    def confirmar(self, ack):
        with self.lock:
            if self.en_vuelo is None or ack.get("ingest_id") != self.en_vuelo["ingest_id"]:
                return
            if ack.get("resultado") not in ("persistido", "duplicado", "cuarentena", "descartado", "rechazado"):
                return
            self.cola.popleft()
            self.en_vuelo = None
            self.espera = 15.0
        self.enviar()

    def bucle(self):
        ultima = 0.0
        energizada = [False] * CANT_PUERTAS
        while True:
            despertado = self.medir_ya.wait(timeout=0.05)
            ahora_s = time.time()
            with self.lock:
                actual = [self.hasta[i] > ahora_s for i in range(CANT_PUERTAS)]
            if actual != energizada:                     # un solenoide se apagó (o prendió)
                energizada = actual
                despertado = True
            if despertado or ahora_s - ultima >= self.config["intervalo_s"]:
                self.medir_ya.clear()
                ultima = ahora_s
                self.medir()
            with self.lock:
                vencida = self.en_vuelo is not None and ahora_s - self.enviada_en > self.espera
                if vencida:
                    self.espera = min(self.espera * 2, 300)
            if vencida:
                log(f"   sin ack de AURA: reintento ({len(self.cola)} muestra(s) en la cola)")
                self.enviar(reintento=True)

    def arrancar(self):
        self.mqtt.connect(*self.broker, keepalive=30)
        self.mqtt.loop_start()
        log(f"Hoja falsa de lockers: hw_id {self.hw}  (aula {self.config['aula']})")
        log(f"Para el puente:  python gateway/puente_mesh.py --broker {self.args.broker} --nodo NODO-A={self.hw}")
        for p in self.args.forzar:
            threading.Thread(target=self.forzar, args=(p,), daemon=True).start()
        try:
            self.bucle()
        except KeyboardInterrupt:
            self.mqtt.loop_stop()
            self.mqtt.disconnect()


def main():
    p = argparse.ArgumentParser(description="Hoja de lockers falsa en la mesh de AURA (MQTT)")
    p.add_argument("--broker", default="localhost:1883")
    p.add_argument("--hw", default="mac-5a0000000a01", help="hw_id de la hoja falsa")
    p.add_argument("--demora", type=float, default=2.0, help="segundos hasta que la persona abre")
    p.add_argument("--cierre", type=float, default=6.0, help="segundos que la puerta queda abierta")
    p.add_argument("--no-abre", type=int, action="append", default=[], metavar="PUERTA")
    p.add_argument("--trabar", type=int, action="append", default=[], metavar="PUERTA")
    p.add_argument("--forzar", type=int, action="append", default=[], metavar="PUERTA")
    p.add_argument("--sin-aula", action="store_true")
    HojaFalsa(p.parse_args()).arrancar()


if __name__ == "__main__":
    main()
