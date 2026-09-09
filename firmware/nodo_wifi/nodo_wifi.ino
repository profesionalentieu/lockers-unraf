/**
 * ============================================================
 *  NODO AUTÓNOMO POR WiFi — sin gateway, sin ESP-NOW
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  PARA QUÉ SIRVE
 *  Probar el sistema COMPLETO con una sola placa: solicitás material desde
 *  el celular, Alumnado aprueba desde el panel, la cerradura se acciona y
 *  el microswitch reporta el estado real de la puerta en el tablero.
 *
 *  Esta placa hace lo que hacían el gateway y el nodo juntos: se conecta al
 *  WiFi y habla HTTP directo con el backend, usando exactamente los mismos
 *  endpoints que consume gateway_serie.py. El servidor no nota la diferencia.
 *
 *      XIAO --WiFi--> GET  /api/gateway/comandos        ¿algo para abrir?
 *      XIAO --WiFi--> POST /api/gateway/comandos/:id/ack   accioné la cerradura
 *      XIAO --WiFi--> POST /api/gateway/telemetria       el microswitch dice...
 *      XIAO --WiFi--> POST /api/gateway/heartbeat        sigo vivo
 *
 *  NO ES SOLO PARA LA PRUEBA
 *  Es una arquitectura válida en sí misma: si el gabinete queda dentro del
 *  alcance del WiFi de la facultad, se puede quedar así y el proyecto se
 *  ahorra una placa entera. ESP-NOW se justifica cuando el gabinete está
 *  fuera de cobertura, o cuando no se quiere depender de la red WiFi.
 *
 *  REQUISITOS
 *  · La PC con el backend y esta placa en la MISMA red.
 *  · Librerías: ArduinoJson v7. WiFi y HTTPClient vienen con el paquete ESP32.
 *  · El backend corriendo (npm start) y el simulador APAGADO: si los dos
 *    consumen la cola, se pelean por los comandos.
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ============================================================
   CONFIGURACIÓN — lo único que hay que tocar
   ============================================================ */
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_CLAVE";

// IP de la PC donde corre el backend (la que da ipconfig), con el puerto.
// OJO: no uses "localhost": desde la placa, localhost es la placa misma.
const char* BACKEND = "http://192.168.0.15:3000";

// Tiene que coincidir con GATEWAY_API_KEY del archivo .env del backend.
const char* API_KEY = "gw-lora-unraf-2025";

const char* NODO_ID = "NODO-A";

/* ============================================================
   HARDWARE
   ============================================================ */

/**
 * Cuántas puertas hay REALMENTE cableadas. Para la prueba de banco con un
 * solo solenoide, dejá 1: el backend sigue mostrando los 4 casilleros, pero
 * solo A-01 (bit 0) existe físicamente. Los comandos para los otros bits se
 * responden igual, así el tablero no queda esperando para siempre.
 */
const uint8_t CANT_PUERTAS = 1;

/**
 * Modo directo: cada solenoide colgado de su propio pin, sin registro de
 * desplazamiento. Es lo que se puede armar antes de tener el SN74HC595.
 * Cuando llegue el integrado, se pasa al firmware de firmware/nodo/.
 */
const uint8_t PIN_SOLENOIDE[CANT_PUERTAS]   = { D1 };
const uint8_t PIN_MICROSWITCH[CANT_PUERTAS] = { D4 };

// Medido en banco: la cerradura suelta desde 100 ms; 150 da 50% de margen.
const uint16_t MS_PULSO_SOLENOIDE = 150;
const uint16_t MS_ANTIRREBOTE     = 50;

const uint32_t MS_ENTRE_CONSULTAS  = 2000;    // igual que el gateway real
const uint32_t MS_HEARTBEAT        = 30000;
const uint32_t MS_REPORTE_COMPLETO = 60000;

/* ============================================================
   ESTADO
   ============================================================ */
bool puertaAbierta[CANT_PUERTAS];
uint32_t ultimoCambio[CANT_PUERTAS];
uint32_t ultimaConsulta = 0, ultimoHeartbeat = 0, ultimoReporte = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=== Nodo autonomo por WiFi - Panol UNRaf ==="));

  // Salidas en bajo ANTES de configurarlas: evita un pulso espurio al arrancar.
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    digitalWrite(PIN_SOLENOIDE[i], LOW);
    pinMode(PIN_SOLENOIDE[i], OUTPUT);
    digitalWrite(PIN_SOLENOIDE[i], LOW);

    pinMode(PIN_MICROSWITCH[i], INPUT_PULLUP);
    puertaAbierta[i] = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    ultimoCambio[i] = millis();
    Serial.printf("Puerta %u: %s\n", i, puertaAbierta[i] ? "ABIERTA" : "cerrada");
  }

  conectarWiFi();
  reportarTodas();          // el tablero arranca sincronizado
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { conectarWiFi(); return; }

  revisarMicroswitches();   // lo más urgente: el estado real de las puertas

  if (millis() - ultimaConsulta > MS_ENTRE_CONSULTAS) {
    consultarComandos();
    ultimaConsulta = millis();
  }
  if (millis() - ultimoReporte > MS_REPORTE_COMPLETO) reportarTodas();
  if (millis() - ultimoHeartbeat > MS_HEARTBEAT) enviarHeartbeat();
}

/* ============================================================
   RED
   ============================================================ */

void conectarWiFi() {
  Serial.printf("Conectando a %s ", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print('.');
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nOK. IP: %s | RSSI: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    Serial.printf("Backend: %s\n\n", BACKEND);
  } else {
    Serial.println(F("\nNo pude conectar. Revisar SSID/clave. Reintento en 5 s."));
    delay(5000);
  }
}

/** GET al backend. Devuelve el cuerpo, o cadena vacía si falló. */
String pedirGet(const String& ruta) {
  HTTPClient http;
  http.begin(String(BACKEND) + ruta);
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(4000);

  int codigo = http.GET();
  String cuerpo = (codigo == 200) ? http.getString() : "";
  if (codigo != 200) Serial.printf("  ! GET %s -> %d\n", ruta.c_str(), codigo);
  http.end();
  return cuerpo;
}

/** POST con cuerpo JSON. Devuelve true si el backend respondió 2xx. */
bool enviarPost(const String& ruta, const String& json) {
  HTTPClient http;
  http.begin(String(BACKEND) + ruta);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(4000);

  int codigo = http.POST(json);
  bool ok = (codigo >= 200 && codigo < 300);
  if (!ok) Serial.printf("  ! POST %s -> %d\n", ruta.c_str(), codigo);
  http.end();
  return ok;
}

/* ============================================================
   COMANDOS
   ============================================================ */

/**
 * Pregunta al backend qué hay para abrir. El propio GET marca los comandos
 * como enviados, así que si la placa se cuelga justo acá, el backend los
 * reintenta solo pasado COMANDO_TIMEOUT_SEG.
 */
void consultarComandos() {
  String cuerpo = pedirGet("/api/gateway/comandos");
  if (cuerpo.isEmpty()) return;

  JsonDocument doc;
  if (deserializeJson(doc, cuerpo)) return;

  for (JsonObject comando : doc["comandos"].as<JsonArray>()) {
    uint32_t id = comando["id"] | 0;
    uint8_t bit = comando["bit"] | 255;
    const char* motivo = comando["motivo"] | "-";
    const char* casillero = comando["casillero"] | "?";

    Serial.printf("-> comando #%u  %s  bit %u  (%s)\n", id, casillero, bit, motivo);

    if (bit < CANT_PUERTAS) {
      // El motivo (RETIRO / DEVOLUCION) se ignora: es la misma acción física.
      accionarSolenoide(bit);
      confirmar(id, true, nullptr);
    } else {
      // Puerta todavía no cableada: lo confirmamos igual para que el tablero
      // no quede esperando un ACK que nunca va a llegar.
      Serial.printf("   (bit %u sin cablear: se confirma sin accionar)\n", bit);
      confirmar(id, true, "puerta no cableada en el prototipo");
    }
  }
}

void confirmar(uint32_t id, bool ok, const char* detalle) {
  JsonDocument doc;
  doc["ok"] = ok;
  if (detalle) doc["detalle"] = detalle;
  String json;
  serializeJson(doc, json);

  if (enviarPost("/api/gateway/comandos/" + String(id) + "/ack", json))
    Serial.printf("<- ACK #%u\n", id);
}

/* ============================================================
   POTENCIA
   ============================================================ */

/**
 * Pulso de apertura. El pin vuelve a LOW SIEMPRE: energizado, el solenoide
 * se calienta, consume 600 mA y termina quemándose.
 */
void accionarSolenoide(uint8_t bit) {
  Serial.printf("   accionando cerradura %u (%u ms)\n", bit, MS_PULSO_SOLENOIDE);
  digitalWrite(PIN_SOLENOIDE[bit], HIGH);
  delay(MS_PULSO_SOLENOIDE);
  digitalWrite(PIN_SOLENOIDE[bit], LOW);
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
    Serial.printf("[microswitch] puerta %u -> %s\n", i, lectura ? "ABIERTA" : "cerrada");
    reportarPuerta(i, lectura);
  }
}

void reportarPuerta(uint8_t bit, bool abierta) {
  JsonDocument doc;
  doc["nodo"] = NODO_ID;
  doc["rssi"] = WiFi.RSSI();
  JsonArray lecturas = doc["lecturas"].to<JsonArray>();
  JsonObject lectura = lecturas.add<JsonObject>();
  lectura["bit"] = bit;
  lectura["puertaAbierta"] = abierta;

  String json;
  serializeJson(doc, json);
  enviarPost("/api/gateway/telemetria", json);
}

/** Reporte completo: resincroniza el tablero si se perdió un cambio. */
void reportarTodas() {
  JsonDocument doc;
  doc["nodo"] = NODO_ID;
  doc["rssi"] = WiFi.RSSI();
  JsonArray lecturas = doc["lecturas"].to<JsonArray>();
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    JsonObject lectura = lecturas.add<JsonObject>();
    lectura["bit"] = i;
    lectura["puertaAbierta"] = puertaAbierta[i];
  }

  String json;
  serializeJson(doc, json);
  enviarPost("/api/gateway/telemetria", json);
  ultimoReporte = millis();
}

void enviarHeartbeat() {
  JsonDocument doc;
  doc["nodo"] = NODO_ID;
  doc["rssi"] = WiFi.RSSI();

  String json;
  serializeJson(doc, json);
  enviarPost("/api/gateway/heartbeat", json);
  ultimoHeartbeat = millis();
}
