/**
 * ============================================================
 *  NODO AUTÓNOMO POR WiFi — ESP32-C3 SUPERMINI (4 LOCKERS)
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ============================================================
   CONFIGURACIÓN DE RED Y SEGURIDAD
   ============================================================ */
const char* WIFI_SSID     = "UNRaf_Libre";
const char* WIFI_PASSWORD = "unraf2021";

// IP fija detectada de tu notebook (Wi-Fi 2)
const char* BACKEND       = "http://10.103.21.91:3000";

// Clave requerida por el backend (.env -> GATEWAY_API_KEY)
const char* API_KEY       = "gw-lora-unraf-2025";
const char* NODO_ID       = "NODO-A";

/* ============================================================
   HARDWARE (ESP32-C3 SUPERMINI — 4 CASILLEROS)
   ============================================================ */
const uint8_t CANT_PUERTAS = 4;

// Salidas a Gates de MOSFETs (A-01: Pin 0, A-02: Pin 1, A-03: Pin 3, A-04: Pin 4)
const uint8_t PIN_SOLENOIDE[CANT_PUERTAS]   = { 0, 1, 3, 4 };

// Entradas desde Microswitches (A-01: Pin 5, A-02: Pin 6, A-03: Pin 7, A-04: Pin 10)
const uint8_t PIN_MICROSWITCH[CANT_PUERTAS] = { 5, 6, 7, 10 };

// Temporizaciones
const uint16_t MS_PULSO_SOLENOIDE = 150;
const uint16_t MS_ANTIRREBOTE     = 50;

const uint32_t MS_ENTRE_CONSULTAS  = 500;    // antes 2000: la placa pregunta por comandos 4 veces por segundo
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
  Serial.println(F("\n=== NODO 4 LOCKERS (ESP32-C3 SUPERMINI) ==="));

  // Inicialización de salidas para MOSFETs (todos en LOW antes de habilitar)
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    digitalWrite(PIN_SOLENOIDE[i], LOW);
    pinMode(PIN_SOLENOIDE[i], OUTPUT);
    digitalWrite(PIN_SOLENOIDE[i], LOW);

    pinMode(PIN_MICROSWITCH[i], INPUT_PULLUP);
    puertaAbierta[i] = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    ultimoCambio[i]  = millis();
    Serial.printf("Locker A-%02u (Pin %u / Switch Pin %u): %s\n", 
                  i + 1, PIN_SOLENOIDE[i], PIN_MICROSWITCH[i], 
                  puertaAbierta[i] ? "ABIERTA" : "CERRADA");
  }

  conectarWiFi();
  reportarTodas(); // Sincroniza las 4 puertas de inmediato en el panel web
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { 
    conectarWiFi(); 
    return; 
  }

  revisarMicroswitches();

  if (millis() - ultimaConsulta > MS_ENTRE_CONSULTAS) {
    consultarComandos();
    ultimaConsulta = millis();
  }
  if (millis() - ultimoReporte > MS_REPORTE_COMPLETO) reportarTodas();
  if (millis() - ultimoHeartbeat > MS_HEARTBEAT) enviarHeartbeat();
}

/* ============================================================
   COMUNICACIÓN HTTP (CON x-api-key)
   ============================================================ */

void conectarWiFi() {
  Serial.printf("Conectando a %s ", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // sin ahorro de energía: cada pedido HTTP sale y vuelve al instante
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print('.');
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[OK] Conectado. IP: %s | RSSI: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    Serial.printf("Backend: %s\n\n", BACKEND);
  } else {
    Serial.println(F("\nFalla de conexion WiFi. Reintento en 5s..."));
    delay(5000);
  }
}

String pedirGet(const String& ruta) {
  HTTPClient http;
  http.begin(String(BACKEND) + ruta);
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(2000);

  int codigo = http.GET();
  String cuerpo = (codigo == 200) ? http.getString() : "";
  if (codigo != 200) Serial.printf("  ! GET %s -> HTTP %d\n", ruta.c_str(), codigo);
  http.end();
  return cuerpo;
}

bool enviarPost(const String& ruta, const String& json) {
  HTTPClient http;
  http.begin(String(BACKEND) + ruta);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(2000);

  int codigo = http.POST(json);
  bool ok = (codigo >= 200 && codigo < 300);
  if (!ok) Serial.printf("  ! POST %s -> HTTP %d\n", ruta.c_str(), codigo);
  http.end();
  return ok;
}

/* ============================================================
   COMANDOS (APERTURAS DESDE EL BACKEND)
   ============================================================ */

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

    Serial.printf("-> COMANDO #%u para %s (bit %u, motivo: %s)\n", id, casillero, bit, motivo);

    if (bit < CANT_PUERTAS) {
      accionarSolenoide(bit);
      confirmar(id, true, nullptr);
    } else {
      Serial.printf("   (bit %u fuera de rango: se confirma sin accionar)\n", bit);
      confirmar(id, true, "casillero no cableado");
    }
  }
}

void confirmar(uint32_t id, bool ok, const char* detalle) {
  JsonDocument doc;
  doc["ok"] = ok;
  if (detalle) doc["detalle"] = detalle;
  String json;
  serializeJson(doc, json);

  if (enviarPost("/api/gateway/comandos/" + String(id) + "/ack", json)) {
    Serial.printf("<- ACK enviado #%u\n", id);
  }
}

void accionarSolenoide(uint8_t bit) {
  if (bit >= CANT_PUERTAS) return;
  Serial.printf("   [POTENCIA] Disparando Solenoide %u (Pin %u, %u ms)\n", 
                bit + 1, PIN_SOLENOIDE[bit], MS_PULSO_SOLENOIDE);
  digitalWrite(PIN_SOLENOIDE[bit], HIGH);
  delay(MS_PULSO_SOLENOIDE);
  digitalWrite(PIN_SOLENOIDE[bit], LOW);
  Serial.println(F("   [POTENCIA] Solenoide desactivado."));
}

/* ============================================================
   TELEMETRÍA (MICROSWITCHES)
   ============================================================ */

void revisarMicroswitches() {
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    bool lectura = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    if (lectura == puertaAbierta[i]) { 
      ultimoCambio[i] = millis(); 
      continue; 
    }
    if (millis() - ultimoCambio[i] < MS_ANTIRREBOTE) continue;

    puertaAbierta[i] = lectura;
    ultimoCambio[i] = millis();
    Serial.printf("[SWITCH] Locker A-%02u -> %s\n", i + 1, lectura ? "ABIERTA" : "CERRADA");
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