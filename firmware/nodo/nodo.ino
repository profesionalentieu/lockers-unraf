/**
 * ============================================================
 *  NODO DEL PAÑOL — ESP32 XIAO con ESP-NOW
 *  Prototipo UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  Qué hace:
 *    1. Escucha por ESP-NOW las órdenes de apertura del gateway.
 *    2. Energiza el solenoide de esa puerta (bit del SN74HC595 -> gate del
 *       IRLZ44N) durante el tiempo que pide la orden: 15 s por
 *       especificación. Es la ventana que tiene la persona para tirar de la
 *       puerta. Después corta, para proteger la bobina.
 *    3. Responde ACK con el mismo id APENAS arranca el pulso.
 *    4. Vigila los finales de carrera y reporta cada cambio, más un reporte
 *       completo periódico que resincroniza si se perdió algo.
 *
 *  POR QUÉ EL PULSO NO USA delay()
 *  Con 150 ms daba igual; con 15 s no: durante el pulso el nodo tiene que
 *  seguir leyendo los microswitches (el backend necesita saber en el acto
 *  que la puerta se abrió) y atender a otras puertas. Cada salida tiene su
 *  propio "hasta cuándo" y el loop() apaga la que venció.
 *
 *  LA FUENTE
 *  Un solenoide de 12 V pide ~0,6 A sostenido y un pico mayor al arrancar.
 *  Por eso: como máximo MAX_SIMULTANEOS bobinas energizadas a la vez, y dos
 *  arranques separados por al menos MS_ENTRE_ARRANQUES (el pico de uno no se
 *  suma al del otro). Una orden que no entra espera su turno en la cola.
 *
 *  Librerías: ArduinoJson (bblanchon) v7. ESP-NOW viene con el núcleo ESP32 3.x.
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
const uint32_t MS_PULSO_DEFECTO   = 15000;  // si la orden no trae "ms"
const uint32_t MS_PULSO_MAXIMO    = 20000;  // tope de seguridad para la bobina
const uint32_t MS_PULSO_MINIMO    = 100;    // medido en banco: suelta desde 100 ms
const uint16_t MS_ANTIRREBOTE     = 50;
const uint32_t MS_REPORTE_COMPLETO = 60000;
const uint32_t MS_HEARTBEAT        = 60000;

// ---------- Potencia ----------
const uint8_t  MAX_SIMULTANEOS    = 2;      // bobinas energizadas a la vez
const uint16_t MS_ENTRE_ARRANQUES = 300;    // separa los picos de arranque
// La especificación pide mantener el pulso los 15 s completos. Si la bobina
// calienta demasiado en las pruebas, poner esto en true: corta apenas el
// switch confirma que la puerta se abrió (ya no hace falta la cerradura suelta).
const bool CORTAR_AL_ABRIR = false;

// ---------- Estado ----------
bool puertaAbierta[CANT_PUERTAS];
uint32_t ultimoCambio[CANT_PUERTAS];
uint32_t ultimoReporte = 0, ultimoHeartbeat = 0;
int ultimoRssi = 0;

uint8_t salidas = 0;                       // lo que hay cargado en el 595
uint32_t pulsoHasta[CANT_PUERTAS] = {0};   // millis() en que se corta (0 = apagada)
uint32_t ultimoArranque = 0;

// Órdenes que esperan turno (una por puerta: si llega otra para la misma
// puerta, la reemplaza; el backend reintenta con el mismo id).
struct Orden { bool pendiente; uint32_t id; uint32_t ms; };
Orden cola[CANT_PUERTAS];

// Las tramas llegan en el contexto de WiFi: no se toca el hardware ahí
// adentro. El callback deja la orden en este buzón y el loop la procesa.
volatile bool hayOrden = false;
volatile uint32_t buzonId = 0, buzonMs = 0;
volatile uint8_t buzonBit = 255;
// El callback corre en la tarea de WiFi (otro núcleo): el buzón se lee y
// se escribe dentro de una sección crítica para no mezclar dos órdenes.
portMUX_TYPE candado = portMUX_INITIALIZER_UNLOCKED;

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
    uint32_t ms = doc["ms"] | MS_PULSO_DEFECTO;
    portENTER_CRITICAL(&candado);
    buzonId = id;
    buzonBit = bit;
    buzonMs = ms;
    hayOrden = true;
    portEXIT_CRITICAL(&candado);
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
    cola[i] = { false, 0, 0 };
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
  // 1. Orden recién llegada -> a la cola de su puerta
  if (hayOrden) {
    portENTER_CRITICAL(&candado);
    uint32_t id = buzonId, ms = buzonMs;
    uint8_t bit = buzonBit;
    hayOrden = false;
    portEXIT_CRITICAL(&candado);
    recibirOrden(bit, id, ms);
  }

  // 2. Potencia: apagar lo que venció y arrancar lo que espera
  atenderPulsos();

  // 3. Telemetría
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

uint8_t activas() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) if (salidas & (1 << i)) n++;
  return n;
}

void recibirOrden(uint8_t bit, uint32_t id, uint32_t ms) {
  ms = constrain(ms, MS_PULSO_MINIMO, MS_PULSO_MAXIMO);
  if (salidas & (1 << bit)) {
    // Esa puerta ya está energizada: es un reintento del backend (o una
    // orden nueva mientras dura el pulso). Se extiende y se confirma.
    pulsoHasta[bit] = millis() + ms;
    enviarAck(id, true);
    return;
  }
  cola[bit] = { true, id, ms };
}

void atenderPulsos() {
  uint32_t ahora = millis();

  // Apagar las que vencieron. El registro vuelve a cero SIEMPRE:
  // energizado, el solenoide se calienta y termina quemándose.
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    if ((salidas & (1 << i)) && (int32_t)(ahora - pulsoHasta[i]) >= 0) {
      salidas &= ~(1 << i);
      escribirRegistro(salidas);
      Serial.printf("Puerta %u: fin del pulso\n", i);
    }
  }

  // Arrancar la primera que espera, si hay lugar y ya pasó el pico anterior.
  if (activas() >= MAX_SIMULTANEOS) return;
  if (ahora - ultimoArranque < MS_ENTRE_ARRANQUES) return;
  for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
    if (!cola[i].pendiente) continue;
    cola[i].pendiente = false;
    salidas |= (1 << i);
    escribirRegistro(salidas);
    pulsoHasta[i] = ahora + cola[i].ms;
    ultimoArranque = ahora;
    Serial.printf("Puerta %u: solenoide energizado %lu ms (comando #%lu)\n",
                  i, (unsigned long)cola[i].ms, (unsigned long)cola[i].id);
    enviarAck(cola[i].id, true);   // ACK = el pulso está en marcha
    return;                        // de a un arranque por vuelta
  }
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

    if (lectura && CORTAR_AL_ABRIR && (salidas & (1 << i))) pulsoHasta[i] = millis();
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
