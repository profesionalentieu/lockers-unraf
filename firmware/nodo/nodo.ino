/**
 * ============================================================
 *  NODO DEL PAÑOL — XIAO ESP32S3 con ESP-NOW
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  Qué hace:
 *    1. Escucha por ESP-NOW las órdenes de apertura del gateway.
 *    2. Pulsa el bit correspondiente del SN74HC595, que dispara el
 *       gate del IRLZ44N y acciona el solenoide de 12 V.
 *    3. Responde ACK con el mismo id, para que el backend sepa qué
 *       comando se ejecutó y no confunda un ACK tardío.
 *    4. Vigila los finales de carrera y reporta cada cambio, más un
 *       reporte completo periódico que resincroniza si se perdió algo.
 *
 *  POR QUÉ DIFUSIÓN (broadcast) Y NO UNICAST
 *  Difundir evita tener que grabar la MAC del gateway en cada nodo y la
 *  de cada nodo en el gateway: las placas se pueden intercambiar sin
 *  tocar el código. Cada trama lleva el campo "nodo" y cada placa filtra
 *  lo suyo, igual que hacía la versión LoRa.
 *  La contra es que la difusión no tiene confirmación a nivel de enlace,
 *  pero eso no importa: la confiabilidad la da el ACK de aplicación con
 *  reintentos que ya maneja el backend.
 *
 *  Librerías: ArduinoJson (bblanchon) v7. ESP-NOW viene con el núcleo ESP32.
 *  Requiere núcleo ESP32 para Arduino 3.x (ver nota del callback abajo).
 * ============================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>

// ---------- Identidad ----------
const char* NODO_ID = "NODO-A";      // tiene que coincidir con la tabla nodos
const uint8_t CANT_PUERTAS = 4;

// ---------- Radio ----------
#define CANAL 1                      // el gateway tiene que usar el mismo
uint8_t BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

// ---------- Pines del registro de desplazamiento SN74HC595 ----------
#define PIN_SR_DATOS  D1   // SER   (pin 14)
#define PIN_SR_RELOJ  D2   // SRCLK (pin 11)
#define PIN_SR_LATCH  D3   // RCLK  (pin 12)
// OE (pin 13) a GND y SRCLR (pin 10) a VCC.
// Pull-down de 10k en cada salida hacia el gate del MOSFET: durante el
// arranque las salidas quedan indefinidas y sin eso un solenoide puede
// dispararse solo al energizar el equipo.

// ---------- Finales de carrera (microswitch) ----------
// Cableado: COM a GND, NO al pin. NC sin conectar.
// INPUT_PULLUP: en reposo (palanca libre) leen HIGH = puerta abierta.
// Puerta cerrada aprieta la palanca -> C-NO cierra a masa -> LOW = cerrada.
// A prueba de fallas: un cable cortado reporta ABIERTA, el estado seguro.
const uint8_t PIN_MICROSWITCH[CANT_PUERTAS] = { D4, D5, D6, D7 };

// ---------- Tiempos ----------
// Medido en banco: la cerradura suelta desde 100 ms; 150 da 50% de margen.
const uint16_t MS_PULSO_SOLENOIDE = 150;
const uint16_t MS_ANTIRREBOTE      = 50;
const uint32_t MS_REPORTE_COMPLETO = 60000;
const uint32_t MS_HEARTBEAT        = 60000;

// ---------- Estado ----------
bool puertaAbierta[CANT_PUERTAS];
uint32_t ultimoCambio[CANT_PUERTAS];
uint32_t ultimoReporte = 0, ultimoHeartbeat = 0;
int ultimoRssi = 0;

// Las órdenes llegan en una interrupción de WiFi: no se puede accionar el
// solenoide ahí adentro. Se guarda el pedido y lo ejecuta el loop.
volatile bool hayOrden = false;
volatile uint32_t ordenId = 0;
volatile uint8_t ordenBit = 255;

void enviar(const String& mensaje) {
  esp_now_send(BROADCAST, (const uint8_t*)mensaje.c_str(), mensaje.length());
}

void transmitir(JsonDocument& doc) {
  String salida;
  serializeJson(doc, salida);
  enviar(salida);
}

/**
 * Recepción de tramas (núcleo 3.x).
 * En el núcleo 2.x la firma es:
 *   void alRecibir(const uint8_t* mac, const uint8_t* datos, int largo)
 * y no hay acceso al RSSI: en ese caso, dejar ultimoRssi en 0.
 */
void alRecibir(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  ultimoRssi = info->rx_ctrl->rssi;

  JsonDocument doc;
  if (deserializeJson(doc, (const char*)datos, largo)) return;

  // El gateway difunde a todos los nodos: cada uno filtra lo suyo.
  if (strcmp(doc["nodo"] | "", NODO_ID) != 0) return;

  const char* accion = doc["accion"] | "";
  uint32_t id = doc["id"] | 0;
  uint8_t bit = doc["bit"] | 255;

  // El campo "motivo" (RETIRO / DEVOLUCION) se ignora a propósito: sacar
  // material y guardarlo son la MISMA acción física.
  if (strcmp(accion, "ABRIR") == 0 && bit < CANT_PUERTAS) {
    ordenId = id;
    ordenBit = bit;
    hayOrden = true;                 // lo ejecuta el loop
  } else if (strcmp(accion, "PING") == 0) {
    enviarAck(id, true);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=== Nodo del pañol UNRaf (ESP-NOW) ==="));

  // --- Salidas hacia el registro de desplazamiento ---
  pinMode(PIN_SR_DATOS, OUTPUT);
  pinMode(PIN_SR_RELOJ, OUTPUT);
  pinMode(PIN_SR_LATCH, OUTPUT);
  escribirRegistro(0);               // todo apagado antes que nada

  // --- Finales de carrera ---
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    pinMode(PIN_MICROSWITCH[i], INPUT_PULLUP);
    puertaAbierta[i] = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    ultimoCambio[i] = millis();
  }

  // --- Radio ---
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(CANAL, WIFI_SECOND_CHAN_NONE);
  Serial.print(F("MAC: ")); Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println(F("ERROR: no se pudo iniciar ESP-NOW"));
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(alRecibir);

  esp_now_peer_info_t destino = {};
  memcpy(destino.peer_addr, BROADCAST, 6);
  destino.channel = CANAL;
  destino.encrypt = false;
  esp_now_add_peer(&destino);

  Serial.printf("Escuchando en el canal %d como %s\n\n", CANAL, NODO_ID);
  reportarTodas();
}

void loop() {
  // Órdenes pendientes, fuera de la interrupción
  if (hayOrden) {
    hayOrden = false;
    uint32_t id = ordenId;
    uint8_t bit = ordenBit;
    Serial.printf("Abriendo puerta %u (comando #%u)\n", bit, id);
    accionarSolenoide(bit);
    enviarAck(id, true);
  }

  revisarMicroswitches();

  if (millis() - ultimoReporte > MS_REPORTE_COMPLETO) reportarTodas();
  if (millis() - ultimoHeartbeat > MS_HEARTBEAT) enviarHeartbeat();
}

/* ============================================================
   POTENCIA: registro de desplazamiento + MOSFET + solenoide
   ============================================================ */

/** Vuelca un byte al SN74HC595 y lo late a las salidas. */
void escribirRegistro(uint8_t valor) {
  digitalWrite(PIN_SR_LATCH, LOW);
  shiftOut(PIN_SR_DATOS, PIN_SR_RELOJ, MSBFIRST, valor);
  digitalWrite(PIN_SR_LATCH, HIGH);
}

/**
 * Pulso de apertura. Un solo bit en alto a la vez: dos solenoides de 12 V
 * juntos son un pico que la fuente del prototipo no aguanta.
 * Y el registro vuelve a cero SIEMPRE: energizado, el solenoide se calienta
 * y termina quemándose.
 */
void accionarSolenoide(uint8_t bit) {
  escribirRegistro(1 << bit);
  delay(MS_PULSO_SOLENOIDE);
  escribirRegistro(0);
}

/* ============================================================
   TELEMETRÍA
   ============================================================ */

/** Antirrebote por software: el contacto mecánico "castañea" al cambiar. */
void revisarMicroswitches() {
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    bool lectura = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    if (lectura == puertaAbierta[i]) { ultimoCambio[i] = millis(); continue; }
    if (millis() - ultimoCambio[i] < MS_ANTIRREBOTE) continue;

    puertaAbierta[i] = lectura;
    ultimoCambio[i] = millis();
    Serial.printf("Puerta %u -> %s\n", i, lectura ? "ABIERTA" : "cerrada");
    reportarPuerta(i, lectura);
  }
}

void reportarPuerta(uint8_t bit, bool abierta) {
  JsonDocument doc;
  doc["tipo"] = "telemetria";
  doc["nodo"] = NODO_ID;
  JsonArray lecturas = doc["lecturas"].to<JsonArray>();
  JsonObject lectura = lecturas.add<JsonObject>();
  lectura["bit"] = bit;
  lectura["puertaAbierta"] = abierta;
  doc["rssi"] = ultimoRssi;
  transmitir(doc);
}

/** Reporte completo periódico: resincroniza si se perdió un cambio. */
void reportarTodas() {
  JsonDocument doc;
  doc["tipo"] = "telemetria";
  doc["nodo"] = NODO_ID;
  JsonArray lecturas = doc["lecturas"].to<JsonArray>();
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    JsonObject lectura = lecturas.add<JsonObject>();
    lectura["bit"] = i;
    lectura["puertaAbierta"] = puertaAbierta[i];
  }
  doc["rssi"] = ultimoRssi;
  transmitir(doc);
  ultimoReporte = millis();
}

void enviarAck(uint32_t id, bool ok) {
  JsonDocument doc;
  doc["tipo"] = "ack";
  doc["id"] = id;
  doc["ok"] = ok;
  doc["rssi"] = ultimoRssi;
  transmitir(doc);
}

void enviarHeartbeat() {
  JsonDocument doc;
  doc["tipo"] = "heartbeat";
  doc["nodo"] = NODO_ID;
  doc["rssi"] = ultimoRssi;
  doc["bateriaMv"] = 4000;   // reemplazar por la lectura real del divisor
  transmitir(doc);
  ultimoHeartbeat = millis();
}
