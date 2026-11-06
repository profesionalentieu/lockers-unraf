#!/usr/bin/env python3
"""
Prueba rápida: manda "abrir" a la hoja del gabinete por el broker MQTT de la mesh y muestra
lo que contesta (transmitido -> recibido -> aplicado / rechazado) y las mediciones siguientes.

    pip install "paho-mqtt>=2.0"
    python gateway\\probar_abrir.py --broker 192.168.0.50
    python gateway\\probar_abrir.py --broker 192.168.0.50 --puerta 1 --ms 5000 --usuario u --clave c
"""
import argparse
import json
import time

import paho.mqtt.client as mqtt

p = argparse.ArgumentParser()
p.add_argument("--broker", required=True, help="IP del broker MQTT de la mesh")
p.add_argument("--puerto", type=int, default=1883)
p.add_argument("--hw", default="mac-70af09040ed4", help="hw_id de la placa")
p.add_argument("--puerta", type=int, default=1)
p.add_argument("--ms", type=int, default=15000)
p.add_argument("--usuario")
p.add_argument("--clave")
p.add_argument("--espera", type=float, default=20, help="segundos escuchando la respuesta")
a = p.parse_args()

cliente = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"prueba-abrir-{int(time.time())}")
if a.usuario:
    cliente.username_pw_set(a.usuario, a.clave)


def al_recibir(_c, _u, msg):
    try:
        datos = json.loads(msg.payload)
    except ValueError:
        datos = msg.payload.decode(errors="replace")
    print(f"{time.strftime('%H:%M:%S')}  <- {msg.topic.split('/', 2)[2]}: {json.dumps(datos, ensure_ascii=False)}")


cliente.on_message = al_recibir
cliente.connect(a.broker, a.puerto, keepalive=30)
for sub in ("response", "data", "status", "alerts/+"):
    cliente.subscribe(f"hw/{a.hw}/{sub}", qos=1)
cliente.loop_start()
time.sleep(1)

orden = {"command": "abrir", "params": {"puerta": a.puerta, "ms": a.ms}, "command_id": f"prueba-{int(time.time())}"}
r = cliente.publish(f"hw/{a.hw}/command", json.dumps(orden, separators=(",", ":")), qos=1)
r.wait_for_publish(5)
print(f"{time.strftime('%H:%M:%S')}  -> command: {json.dumps(orden)}")
print(f"Escuchando {a.espera:.0f} s... (aplicado = la placa energizó el solenoide)")
time.sleep(a.espera)
cliente.loop_stop()
cliente.disconnect()
