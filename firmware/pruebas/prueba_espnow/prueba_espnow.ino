/**
 * ============================================================
 *  PRUEBA DE ENLACE ESP-NOW — ping-pong con estadísticas
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  Una placa manda pings numerados, la otra los devuelve. La sonda mide
 *  el tiempo de ida y vuelta, la potencia recibida de cada lado y cuántos
 *  paquetes se perdieron.
 *
 *  Es la prueba que reemplaza a la de LoRa. Lo importante acá NO es
 *  confirmar que funciona (ESP-NOW casi siempre funciona en la mesa),
 *  sino MEDIR EL ALCANCE REAL en el edificio: a 2,4 GHz el hormigón
 *  atenúa mucho, y de eso depende dónde puede estar el gateway.
 *
 *  CÓMO USARLO
 *  1. En una placa dejá  #define ES_SONDA true   (la que mide)
 *     En la otra poné    #define ES_SONDA false  (la que responde)
 *  2. Monitor serie a 115200 en la sonda.
 *  3. Alejate con la placa que responde y anotá el RSSI a cada distancia.
 *
 *  CÓMO LEER LOS NÚMEROS
 *    RSSI  potencia recibida en dBm. Menos negativo es mejor.
 *          -40 al lado · -70 bien · -85 al límite · -90 se corta
 *    RTT   ida y vuelta en ms. Esperá entre 2 y 15 ms: ESP-NOW es
 *          muchísimo más rápido que LoRa.
 *
 *  REQUISITOS
 *  Núcleo ESP32 para Arduino 3.x. Si usás el 2.x, la firma del callback
 *  de recepción es distinta (recibe solo la MAC, sin datos de RSSI) y
 *  hay que adaptarla; está indicado más abajo.
 * ============================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---------- ROL: cambiar acá y recargar en cada placa ----------
#define ES_SONDA true

// Canal WiFi. Las dos placas TIENEN que usar el mismo.
#define CANAL 1

const uint32_t MS_ENTRE_PINGS = 1000;
const uint32_t MS_ESPERA_RESPUESTA = 500;   // ESP-NOW responde en milisegundos

// Difusión: evita tener que configurar las MAC de cada placa.
uint8_t BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

// ---------- Estado ----------
volatile bool hayRespuesta = false;
volatile uint32_t seqRecibida = 0;
volatile int rssiLocal = 0, rssiRemoto = 0;
uint32_t enviados = 0, recibidos = 0, sumaRtt = 0;
int peorRssi = 0, mejorRssi = -200;

/** Envía un texto por difusión. */
void enviar(const String& mensaje) {
  esp_now_send(BROADCAST, (const uint8_t*)mensaje.c_str(), mensaje.length());
}

/**
 * Callback de recepción (núcleo 3.x).
 * En el núcleo 2.x la firma es:  void alRecibir(const uint8_t* mac, const uint8_t* datos, int largo)
 * y no hay acceso al RSSI.
 */
void alRecibir(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  String mensaje((const char*)datos, largo);
  int rssi = info->rx_ctrl->rssi;

#if ES_SONDA
  // Espero "PONG;<seq>;<rssi del otro extremo>"
  if (!mensaje.startsWith("PONG;")) return;
  int c1 = mensaje.indexOf(';');
  int c2 = mensaje.indexOf(';', c1 + 1);
  seqRecibida = mensaje.substring(c1 + 1, c2).toInt();
  rssiRemoto = mensaje.substring(c2 + 1).toInt();
  rssiLocal = rssi;
  hayRespuesta = true;
#else
  // Devuelvo cada ping con el RSSI que medí
  if (!mensaje.startsWith("PING;")) return;
  String seq = mensaje.substring(mensaje.indexOf(';') + 1);
  Serial.printf("ping #%s recibido a %d dBm -> devolviendo\n", seq.c_str(), rssi);
  enviar("PONG;" + seq + ";" + String(rssi));
#endif
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 5000) delay(10);
  delay(300);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();   // ESP-NOW no necesita estar asociado a ninguna red
  esp_wifi_set_channel(CANAL, WIFI_SECOND_CHAN_NONE);

  Serial.println(F("\n=============================================="));
  Serial.print(F("  Prueba ESP-NOW - rol: "));
  Serial.println(ES_SONDA ? F("SONDA (mide)") : F("ECO (responde)"));
  Serial.print(F("  MAC de esta placa: "));
  Serial.println(WiFi.macAddress());
  Serial.printf("  Canal: %d\n", CANAL);
  Serial.println(F("=============================================="));

  if (esp_now_init() != ESP_OK) {
    Serial.println(F("ERROR: no se pudo iniciar ESP-NOW"));
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(alRecibir);

  // Aun para difundir hay que dar de alta el destino.
  esp_now_peer_info_t destino = {};
  memcpy(destino.peer_addr, BROADCAST, 6);
  destino.channel = CANAL;
  destino.encrypt = false;
  if (esp_now_add_peer(&destino) != ESP_OK) {
    Serial.println(F("ERROR: no se pudo agregar el destino de difusion"));
    while (true) delay(1000);
  }

#if ES_SONDA
  Serial.println(F("\nseq | RTT  | RSSI local | RSSI remoto | perdidos"));
  Serial.println(F("----+------+------------+-------------+---------"));
#else
  Serial.println(F("\nEsperando pings..."));
#endif
}

#if ES_SONDA
void loop() {
  enviados++;
  hayRespuesta = false;

  uint32_t salida = millis();
  enviar("PING;" + String(enviados));

  while (millis() - salida < MS_ESPERA_RESPUESTA && !hayRespuesta) delay(1);

  if (hayRespuesta && seqRecibida == enviados) {
    uint32_t rtt = millis() - salida;
    recibidos++;
    sumaRtt += rtt;
    if (rssiLocal < peorRssi || peorRssi == 0) peorRssi = rssiLocal;
    if (rssiLocal > mejorRssi) mejorRssi = rssiLocal;

    Serial.printf("%3u | %3u  |   %4d dBm |    %4d dBm | %u\n",
                  enviados, rtt, rssiLocal, rssiRemoto, enviados - recibidos);
  } else {
    Serial.printf("%3u | ---  |    PERDIDO (sin respuesta)   | %u\n",
                  enviados, enviados - recibidos);
  }

  if (enviados % 10 == 0) {
    float entrega = (100.0 * recibidos) / enviados;
    Serial.println(F("----+------+------------+-------------+---------"));
    Serial.printf("RESUMEN: %u/%u entregados (%.0f%%) · RTT medio %u ms · RSSI entre %d y %d dBm\n",
                  recibidos, enviados, entrega,
                  recibidos ? sumaRtt / recibidos : 0, peorRssi, mejorRssi);
    if (entrega < 90)
      Serial.println(F("  Perdida alta: estas cerca del limite de alcance."));
    Serial.println(F("----+------+------------+-------------+---------"));
  }

  delay(MS_ENTRE_PINGS);
}
#else
void loop() { delay(100); }   // todo el trabajo ocurre en el callback
#endif
