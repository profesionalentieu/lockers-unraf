/**
 * ============================================================
 *  NODO AUTÓNOMO POR WiFi — ESP32-C3 SUPERMINI (4 LOCKERS)
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  Mismos pines, mismos endpoints y mismos mensajes que la versión
 *  anterior. Lo que cambia es CÓMO se organiza el trabajo, para que no
 *  haya demoras:
 *
 *  · Tarea "puertas" (en paralelo con loop): lee los 4 microswitches cada
 *    5 ms y reporta cada cambio al instante. Si un reporte falla, lo
 *    reintenta hasta que llega; antes se perdía. También manda el reporte
 *    completo (cada 60 s) y el heartbeat (cada 30 s).
 *
 *  · loop(): consulta comandos cada 300 ms, acciona la cerradura y manda
 *    el ACK (con reintento).
 *
 *  · Cada una de las dos partes tiene su propia conexión HTTP persistente
 *    (keep-alive): no se abre una conexión TCP nueva por cada pedido.
 *
 *  · WiFi sin ahorro de energía (WiFi.setSleep(false)).
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ============================================================
   CONFIGURACIÓN DE RED Y SEGURIDAD
   ============================================================ */
const char* WIFI_SSID     = "iPhone de Matias";
const char* WIFI_PASSWORD = "matutee200";

// IP de la notebook donde corre el backend (la que da ipconfig)
const char* BACKEND       = "http://172.20.10.7:3000";

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

const uint32_t MS_ENTRE_CONSULTAS  = 300;    // cada cuánto se preguntan comandos
const uint32_t MS_HEARTBEAT        = 30000;
const uint32_t MS_REPORTE_COMPLETO = 60000;
const uint32_t MS_REINTENTO        = 300;    // si un reporte de puerta falla
const uint16_t MS_TIMEOUT_HTTP     = 3000;
const uint32_t MS_CONEXION_OCIOSA  = 4000;   // Node cierra las conexiones quietas a los 5 s

/* ============================================================
   ESTADO
   ============================================================ */
// Estado de las puertas: después de setup() solo lo toca la tarea de puertas.
bool puertaAbierta[CANT_PUERTAS];
uint32_t ultimoCambio[CANT_PUERTAS];
bool pendienteReporte[CANT_PUERTAS];   // cambió y todavía no llegó al servidor

uint32_t ultimaConsulta = 0;

// Una conexión HTTP persistente: cliente TCP + cliente HTTP + último uso.
struct Conexion {
  WiFiClient cliente;
  HTTPClient http;
  uint32_t ultimoUso = 0;
};

Conexion conexComandos;   // la usa loop()
Conexion conexPuertas;    // la usa la tarea de puertas

/* Declaraciones (el IDE las genera solo, pero así no depende de eso) */
void conectarWiFi();
int  pedido(Conexion& c, const String& ruta, const String& json, String& respuesta);
void consultarComandos();
void confirmar(uint32_t id, bool ok, const char* detalle);
void accionarSolenoide(uint8_t bit);
void tareaPuertas(void* parametro);
void revisarMicroswitches();
bool hayPendientes();
bool enviarPendientes();
void enviarHeartbeat();

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
    puertaAbierta[i]    = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    ultimoCambio[i]     = millis();
    pendienteReporte[i] = true;   // sincroniza las 4 puertas apenas haya red
    Serial.printf("Locker A-%02u (Pin %u / Switch Pin %u): %s\n",
                  i + 1, PIN_SOLENOIDE[i], PIN_MICROSWITCH[i],
                  puertaAbierta[i] ? "ABIERTA" : "CERRADA");
  }

  conectarWiFi();

  // Las puertas se atienden en su propia tarea, con más prioridad que loop():
  // aunque loop() esté esperando al servidor, los switches se siguen leyendo.
  xTaskCreate(tareaPuertas, "puertas", 8192, nullptr, 2, nullptr);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
    return;
  }

  if (millis() - ultimaConsulta >= MS_ENTRE_CONSULTAS) {
    consultarComandos();
    ultimaConsulta = millis();
  }
  delay(5);
}

/* ============================================================
   COMUNICACIÓN HTTP (CON x-api-key)
   ============================================================ */

void conectarWiFi() {
  Serial.printf("Conectando a %s ", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // sin ahorro de energía: cada pedido sale y vuelve al instante
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

/**
 * Hace un GET (json vacío) o un POST (json con contenido) sobre una conexión
 * persistente. Devuelve el código HTTP; negativo = error de red.
 * Si la conexión vieja estaba muerta, se descarta y se prueba una vez con una nueva.
 */
int pedido(Conexion& c, const String& ruta, const String& json, String& respuesta) {
  // Si la conexión estuvo quieta, el servidor pudo haberla cerrado:
  // mejor abrir una nueva que tropezar con una muerta.
  if (millis() - c.ultimoUso > MS_CONEXION_OCIOSA) c.cliente.stop();

  int codigo = -1;
  for (uint8_t intento = 0; intento < 2; intento++) {
    c.http.begin(c.cliente, String(BACKEND) + ruta);
    c.http.setReuse(true);
    c.http.setConnectTimeout(MS_TIMEOUT_HTTP);
    c.http.setTimeout(MS_TIMEOUT_HTTP);
    c.http.addHeader("x-api-key", API_KEY);

    if (json.length()) {
      c.http.addHeader("Content-Type", "application/json");
      codigo = c.http.POST(json);
    } else {
      codigo = c.http.GET();
    }

    if (codigo > 0) {
      respuesta = c.http.getString();   // se lee entera para dejar la conexión limpia
      c.http.end();                     // con setReuse(true) la conexión TCP queda abierta
      c.ultimoUso = millis();
      return codigo;
    }

    // Error de red: se descarta esta conexión y se prueba una vez con otra.
    c.http.end();
    c.cliente.stop();
  }
  return codigo;
}

/* ============================================================
   COMANDOS (APERTURAS DESDE EL BACKEND) — corre en loop()
   ============================================================ */

void consultarComandos() {
  String cuerpo;
  int codigo = pedido(conexComandos, "/api/gateway/comandos", "", cuerpo);
  if (codigo != 200) {
    Serial.printf("  ! GET /api/gateway/comandos -> HTTP %d %s\n", codigo,
                  codigo < 0 ? HTTPClient::errorToString(codigo).c_str() : "");
    return;
  }

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

  String ruta = "/api/gateway/comandos/" + String(id) + "/ack";
  for (uint8_t intento = 1; intento <= 3; intento++) {
    String respuesta;
    int codigo = pedido(conexComandos, ruta, json, respuesta);
    if (codigo >= 200 && codigo < 300) {
      Serial.printf("<- ACK enviado #%u\n", id);
      return;
    }
    Serial.printf("  ! ACK #%u -> HTTP %d %s\n", id, codigo,
                  codigo < 0 ? HTTPClient::errorToString(codigo).c_str() : respuesta.c_str());
    if (codigo > 0) return;   // el servidor respondió (ej. 404): reintentar no cambia nada
    delay(200);
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
   TELEMETRÍA (MICROSWITCHES) — corre en su propia tarea
   ============================================================ */

void tareaPuertas(void* parametro) {
  uint32_t ultimoReporte   = millis();   // el reporte inicial ya quedó marcado en setup()
  uint32_t ultimoHeartbeat = millis();
  uint32_t proximoIntento  = 0;

  for (;;) {
    revisarMicroswitches();

    // Reporte completo periódico: se marcan las 4 como pendientes.
    if (millis() - ultimoReporte >= MS_REPORTE_COMPLETO) {
      for (uint8_t i = 0; i < CANT_PUERTAS; i++) pendienteReporte[i] = true;
      ultimoReporte = millis();
    }

    if (WiFi.status() == WL_CONNECTED) {
      if (hayPendientes()) {
        if ((int32_t)(millis() - proximoIntento) >= 0 && !enviarPendientes()) {
          proximoIntento = millis() + MS_REINTENTO;
        }
      } else if (millis() - ultimoHeartbeat >= MS_HEARTBEAT) {
        enviarHeartbeat();
        ultimoHeartbeat = millis();
      }
    }

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void revisarMicroswitches() {
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    bool lectura = (digitalRead(PIN_MICROSWITCH[i]) == HIGH);
    if (lectura == puertaAbierta[i]) {
      ultimoCambio[i] = millis();
      continue;
    }
    if (millis() - ultimoCambio[i] < MS_ANTIRREBOTE) continue;

    puertaAbierta[i]    = lectura;
    ultimoCambio[i]     = millis();
    pendienteReporte[i] = true;
    Serial.printf("[SWITCH] Locker A-%02u -> %s\n", i + 1, lectura ? "ABIERTA" : "CERRADA");
  }
}

bool hayPendientes() {
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) if (pendienteReporte[i]) return true;
  return false;
}

/** Manda en un solo POST todas las puertas pendientes. true si llegó. */
bool enviarPendientes() {
  JsonDocument doc;
  doc["nodo"] = NODO_ID;
  doc["rssi"] = WiFi.RSSI();
  JsonArray lecturas = doc["lecturas"].to<JsonArray>();

  bool incluida[CANT_PUERTAS] = {};
  uint8_t cantidad = 0;
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    if (!pendienteReporte[i]) continue;
    JsonObject lectura = lecturas.add<JsonObject>();
    lectura["bit"] = i;
    lectura["puertaAbierta"] = puertaAbierta[i];
    incluida[i] = true;
    cantidad++;
  }

  String json;
  serializeJson(doc, json);

  uint32_t inicio = millis();
  String respuesta;
  int codigo = pedido(conexPuertas, "/api/gateway/telemetria", json, respuesta);

  if (codigo >= 200 && codigo < 300) {
    for (uint8_t i = 0; i < CANT_PUERTAS; i++) if (incluida[i]) pendienteReporte[i] = false;
    Serial.printf("  <- telemetria OK: %u puerta(s) en %lu ms\n",
                  cantidad, (unsigned long)(millis() - inicio));
    return true;
  }

  Serial.printf("  ! POST telemetria -> HTTP %d %s (se reintenta)\n", codigo,
                codigo < 0 ? HTTPClient::errorToString(codigo).c_str() : respuesta.c_str());
  return false;
}

void enviarHeartbeat() {
  JsonDocument doc;
  doc["nodo"] = NODO_ID;
  doc["rssi"] = WiFi.RSSI();

  String json;
  serializeJson(doc, json);

  String respuesta;
  int codigo = pedido(conexPuertas, "/api/gateway/heartbeat", json, respuesta);
  if (codigo < 200 || codigo >= 300) {
    Serial.printf("  ! POST /api/gateway/heartbeat -> HTTP %d\n", codigo);
  }
}
