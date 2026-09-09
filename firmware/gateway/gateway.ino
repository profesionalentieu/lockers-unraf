/**
 * ============================================================
 *  GATEWAY DEL PAÑOL — XIAO ESP32S3 con ESP-NOW
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  Esta placa no piensa: es un cable. Traduce entre el puerto serie
 *  (que lee gateway_serie.py en la PC) y la radio ESP-NOW.
 *
 *      PC  --serie-->  esta placa  --ESP-NOW-->  nodo
 *      PC  <--serie--  esta placa  <--ESP-NOW--  nodo
 *
 *  Toda la lógica (cola de comandos, reintentos, estados) vive en el
 *  backend. Si mañana cambian las reglas del pañol, esta placa no se toca.
 *
 *  ⚠ El CANAL tiene que ser el mismo que el del nodo. Es la causa número
 *    uno de "no se escuchan": las dos placas inician bien, no da ningún
 *    error, y simplemente no se ven.
 *
 *  Librerías: ArduinoJson v7. ESP-NOW viene con el núcleo ESP32 (3.x).
 * ============================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define CANAL 1
uint8_t BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

/**
 * Lo que llega por radio se reenvía tal cual a la PC.
 * (Núcleo 2.x: la firma es (const uint8_t* mac, const uint8_t* datos, int largo).)
 */
void alRecibir(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  // El gateway no interpreta el contenido: solo lo pasa.
  Serial.write(datos, largo);
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(CANAL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    // Se avisa en JSON para que el script de la PC lo loguee igual que todo lo demás.
    Serial.println("{\"tipo\":\"error\",\"detalle\":\"no se pudo iniciar ESP-NOW\"}");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(alRecibir);

  esp_now_peer_info_t destino = {};
  memcpy(destino.peer_addr, BROADCAST, 6);
  destino.channel = CANAL;
  destino.encrypt = false;
  esp_now_add_peer(&destino);

  Serial.printf("{\"tipo\":\"listo\",\"detalle\":\"gateway ESP-NOW canal %d\",\"mac\":\"%s\"}\n",
                CANAL, WiFi.macAddress().c_str());
}

void loop() {
  // ---------- BAJADA: PC -> radio ----------
  // Una línea JSON por comando, tal como la manda gateway_serie.py.
  if (Serial.available()) {
    String linea = Serial.readStringUntil('\n');
    linea.trim();
    if (linea.length() > 0) {
      esp_now_send(BROADCAST, (const uint8_t*)linea.c_str(), linea.length());
    }
  }
}
