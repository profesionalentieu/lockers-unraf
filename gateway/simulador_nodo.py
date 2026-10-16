#!/usr/bin/env python3
"""
SIMULADOR DE NODO — el sistema completo funcionando sin una sola placa.

Hace de gateway, de nodo y de la persona frente a la puerta (igual que
simulador_nodo.js, para quien prefiera Python):

  1. Consulta las ordenes al backend real.
  2. "Energiza" el solenoide el tiempo que pide la orden (ms = 15000) y
     manda el ACK apenas arranca el pulso.
  3. Simula a alguien que abre a los 2-5 s, deja la puerta abierta unos
     segundos y la cierra: el microswitch reporta ABIERTO y despues CERRADO.

Uso (con el backend corriendo en otra terminal):
    pip install requests
    python simulador_nodo.py

Opciones para ensayar la especificacion:
    --no-abre A-02    nadie abre: a los 15 s aparece "Reintentar apertura"
    --trabar A-03     la puerta nunca cierra: alerta a los 45 s, ERROR a los 120 s
    --cierre 50       segundos con la puerta abierta (por defecto 8)
    --perder 30       descarta el 30% de las ordenes, como una radio real
    --backend http://192.168.0.10:3000
"""

import argparse
import os
import random
import threading
import time

import requests

API_KEY = os.environ.get("GATEWAY_API_KEY", "gw-lora-unraf-2025")   # = GATEWAY_API_KEY del .env
NODO = "NODO-A"
INTERVALO_POLL = 1.0
INTERVALO_HEARTBEAT = 30

LOCKERS = {0: "A-01", 1: "A-02", 2: "A-03", 3: "A-04"}


class SimuladorNodo:
    def __init__(self, backend, no_abre, trabadas, cierre, perdida):
        self.backend = backend.rstrip("/")
        self.no_abre = no_abre
        self.trabadas = trabadas
        self.cierre = cierre
        self.perdida = perdida
        self.sesion = requests.Session()
        self.sesion.headers.update({"x-api-key": API_KEY, "Content-Type": "application/json"})
        self.abiertas = set()
        self.ultimo_heartbeat = 0.0

    @staticmethod
    def rssi():
        return random.randint(-85, -55)

    def enviar(self, ruta, cuerpo):
        try:
            return self.sesion.post(f"{self.backend}{ruta}", json=cuerpo, timeout=5)
        except Exception as e:
            print(f"  ! no pude hablar con el backend: {e}")
            return None

    def reportar_puerta(self, bit, abierta):
        self.enviar("/api/gateway/telemetria",
                    {"nodo": NODO, "lecturas": [{"bit": bit, "puertaAbierta": abierta}], "rssi": self.rssi()})

    def despues(self, segundos, funcion):
        threading.Timer(segundos, funcion).start()

    # ---------- el circuito ----------

    def procesar_comando(self, comando):
        bit = comando["bit"]
        locker = LOCKERS.get(bit, f"bit {bit}")
        pulso = min(int(comando.get("ms") or 15000), 20000) / 1000

        if random.randint(1, 100) <= self.perdida:
            print(f"  ~ orden #{comando['id']} ({locker}) PERDIDA en el aire: el backend reintenta")
            return

        print(f"  -> orden #{comando['id']} {locker} · {comando.get('motivo')} · solenoide {pulso:.0f} s")
        self.enviar(f"/api/gateway/comandos/{comando['id']}/ack", {"ok": True, "detalle": "simulador"})
        self.despues(pulso, lambda: print(f"     {locker}: fin del pulso, solenoide sin energía"))

        if bit in self.abiertas:
            return
        if locker in self.no_abre:
            print(f"     {locker}: nadie tira de la puerta (--no-abre)")
            return

        def abrir():
            self.abiertas.add(bit)
            self.reportar_puerta(bit, True)
            print(f"  <- microswitch: {locker} ABIERTO")
            if locker in self.trabadas:
                print(f"     {locker}: queda abierta (--trabar)")
                return

            def cerrar():
                self.abiertas.discard(bit)
                self.reportar_puerta(bit, False)
                print(f"  <- microswitch: {locker} CERRADO")

            self.despues(self.cierre, cerrar)

        self.despues(random.uniform(2, min(5, pulso - 1)), abrir)

    def heartbeat(self):
        if time.time() - self.ultimo_heartbeat < INTERVALO_HEARTBEAT:
            return
        self.ultimo_heartbeat = time.time()
        self.enviar("/api/gateway/heartbeat",
                    {"nodo": NODO, "rssi": self.rssi(), "bateriaMv": random.randint(3900, 4150)})

    def arrancar(self):
        print(f"Simulador de {NODO} contra {self.backend}")
        if self.no_abre:
            print(f"  puertas que nadie abre: {', '.join(sorted(self.no_abre))}")
        if self.trabadas:
            print(f"  puertas que quedan abiertas: {', '.join(sorted(self.trabadas))}")
        if self.perdida:
            print(f"  pérdida de órdenes simulada: {self.perdida}%")
        print("Ctrl+C para salir.\n")

        self.enviar("/api/gateway/telemetria", {
            "nodo": NODO, "rssi": self.rssi(),
            "lecturas": [{"bit": bit, "puertaAbierta": False} for bit in LOCKERS],
        })

        while True:
            try:
                respuesta = self.sesion.get(f"{self.backend}/api/gateway/comandos", timeout=5)
                for comando in respuesta.json().get("comandos", []):
                    self.procesar_comando(comando)
                self.heartbeat()
            except requests.exceptions.ConnectionError:
                print("  ! el backend no responde (¿npm start está corriendo?)")
            except Exception as e:
                print(f"  ! {e}")
            time.sleep(INTERVALO_POLL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Simulador de nodo para el pañol")
    parser.add_argument("--backend", default="http://localhost:3000")
    parser.add_argument("--no-abre", nargs="*", default=[], help="lockers que nadie abre, ej: --no-abre A-02")
    parser.add_argument("--trabar", nargs="*", default=[], help="lockers que nunca cierran, ej: --trabar A-03")
    parser.add_argument("--cierre", type=float, default=8, help="segundos con la puerta abierta")
    parser.add_argument("--perder", type=int, default=0, help="porcentaje de órdenes que se pierden (0-100)")
    a = parser.parse_args()

    try:
        SimuladorNodo(a.backend, {x.upper() for x in a.no_abre}, {x.upper() for x in a.trabar},
                      a.cierre, a.perder).arrancar()
    except KeyboardInterrupt:
        print("\nSimulador detenido.")
        os._exit(0)
