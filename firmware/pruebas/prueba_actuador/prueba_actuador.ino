/**
 * ============================================================
 *  PRUEBA DE ACTUADOR — un solenoide + un microswitch
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  PARA QUÉ SIRVE
 *  Validar toda la etapa de potencia SIN el registro de desplazamiento
 *  y SIN LoRa: un MOSFET colgado de un pin del micro. Es lo que se puede
 *  hacer el primer día, y responde la pregunta más importante del
 *  proyecto físico:
 *
 *      ¿Cuántos milisegundos de pulso necesita la cerradura para soltar?
 *
 *  Ese número va después en MS_PULSO_SOLENOIDE de nodo.ino. Ponerlo "a
 *  ojo" es lo que hace que después una puerta abra y otra no.
 *
 *  CONEXIONADO (una sola puerta)
 *
 *     12 V ──┬────────────────┐
 *            │            [solenoide]
 *          [1N4007]           │        <- cátodo (la franja) ARRIBA
 *     (franja al +12 V)       │
 *            └────────────────┤
 *                             │
 *                          DRAIN
 *     PIN_GATE ───[gate]   IRLZ44N
 *                    │     SOURCE
 *                [10 kΩ]      │
 *                    │        │
 *     GND ───────────┴────────┴───── al GND del micro (MASA COMÚN)
 *
 *     Microswitch:  COM ── GND      NO ── PIN_MICROSWITCH
 *
 *     Se usa NO (normalmente abierto), no NC: con la puerta cerrada la
 *     palanca queda apretada, el contacto C-NO cierra a masa y el pin lee
 *     LOW = cerrada. Ademas es a prueba de fallas: un cable cortado deja el
 *     circuito abierto y el sistema reporta ABIERTA, que es el estado seguro.
 *     Ojo: en algunos modelos el terminal del medio NO es el COM. Verificar
 *     lo impreso en el cuerpo del switch.
 *
 *  ⚠ TRES COSAS QUE QUEMAN EL CIRCUITO
 *   1. Sin el diodo flyback, el pico inverso de la bobina mata al MOSFET.
 *   2. Sin masa común entre la fuente de 12 V y el micro, el gate no tiene
 *      referencia y pasan cosas raras.
 *   3. Nunca conectes el solenoide directo a un pin: un GPIO da ~20 mA y
 *      el solenoide pide 600. Siempre a través del MOSFET.
 *
 *  CÓMO USARLO
 *  Monitor serie a 115200. Comandos (escribir y Enter):
 *      p        pulso con la duración actual
 *      + / -    subir o bajar la duración en 50 ms
 *      b        barrido: prueba de 100 a 800 ms para encontrar el mínimo
 *      s        estado del microswitch
 *      r        repetir 20 pulsos seguidos (prueba de calentamiento)
 * ============================================================
 */

// ---------- Pines (cualquier GPIO libre sirve) ----------
#define PIN_GATE        D1   // al gate del IRLZ44N
#define PIN_MICROSWITCH D4   // al final de carrera

// ---------- Parámetros ----------
uint16_t msPulso = 400;              // duración inicial del pulso
const uint16_t MS_MINIMO = 50;
const uint16_t MS_MAXIMO = 1500;     // más que esto calienta la bobina al pedo
const uint16_t MS_ANTIRREBOTE = 50;

bool puertaAbierta = false;
uint32_t ultimoCambio = 0;

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 5000) delay(10);

  // El gate en bajo ANTES de configurarlo como salida: evita un pulso
  // espurio en el arranque que dispare la cerradura sola.
  digitalWrite(PIN_GATE, LOW);
  pinMode(PIN_GATE, OUTPUT);
  digitalWrite(PIN_GATE, LOW);

  pinMode(PIN_MICROSWITCH, INPUT_PULLUP);
  puertaAbierta = (digitalRead(PIN_MICROSWITCH) == HIGH);

  Serial.println(F("\n=================================================="));
  Serial.println(F("  Prueba de actuador - solenoide 12V / 600 mA"));
  Serial.println(F("=================================================="));
  Serial.println(F("  p      pulso"));
  Serial.println(F("  + / -  ajustar duracion (50 ms)"));
  Serial.println(F("  b      barrido 100..800 ms (buscar el minimo)"));
  Serial.println(F("  s      estado del microswitch"));
  Serial.println(F("  r      20 pulsos seguidos (calentamiento)"));
  Serial.println(F("=================================================="));
  Serial.printf("  Duracion actual: %u ms\n", msPulso);
  Serial.printf("  Puerta: %s\n\n", puertaAbierta ? "ABIERTA" : "cerrada");
}

void loop() {
  vigilarMicroswitch();

  if (!Serial.available()) return;
  char orden = Serial.read();
  while (Serial.available()) Serial.read();   // descarta el resto de la línea

  switch (orden) {
    case 'p': pulso(msPulso); break;
    case '+':
      msPulso = min<uint16_t>(msPulso + 50, MS_MAXIMO);
      Serial.printf("Duracion: %u ms\n", msPulso);
      break;
    case '-':
      msPulso = max<uint16_t>(msPulso - 50, MS_MINIMO);
      Serial.printf("Duracion: %u ms\n", msPulso);
      break;
    case 'b': barrido(); break;
    case 's':
      Serial.printf("Microswitch: %s (lectura %s)\n",
                    puertaAbierta ? "puerta ABIERTA" : "puerta cerrada",
                    digitalRead(PIN_MICROSWITCH) ? "HIGH" : "LOW");
      break;
    case 'r': repetir(); break;
    default: break;
  }
}

/** Un pulso: energiza, espera, corta. El registro SIEMPRE vuelve a cero. */
void pulso(uint16_t ms) {
  Serial.printf("\n>> Pulso de %u ms ... ", ms);
  uint32_t t0 = millis();
  digitalWrite(PIN_GATE, HIGH);
  delay(ms);
  digitalWrite(PIN_GATE, LOW);   // imprescindible: energizado se calienta y se quema

  // Damos un momento para ver si el final de carrera acusa el movimiento.
  delay(300);
  bool abrio = (digitalRead(PIN_MICROSWITCH) == HIGH);
  Serial.printf("listo (%lu ms totales) -> microswitch dice %s\n",
                millis() - t0, abrio ? "ABIERTA" : "cerrada");
}

/**
 * Barrido: busca la duración mínima que suelta el pestillo.
 * Empezá con la puerta cerrada y mirá a partir de qué valor abre.
 */
void barrido() {
  Serial.println(F("\n=== BARRIDO: de 100 a 800 ms ==="));
  Serial.println(F("Cerra la puerta antes de cada intento. Enter para seguir."));
  for (uint16_t ms = 100; ms <= 800; ms += 100) {
    Serial.printf("\n-- Probando %u ms. Enter cuando la puerta este cerrada...\n", ms);
    while (!Serial.available()) delay(50);
    while (Serial.available()) Serial.read();
    pulso(ms);
  }
  Serial.println(F("\n=== Fin del barrido ==="));
  Serial.println(F("Tomá el valor mínimo que abrió SIEMPRE y sumale un 50%"));
  Serial.println(F("de margen. Ese número va en MS_PULSO_SOLENOIDE de nodo.ino."));
}

/**
 * 20 pulsos seguidos. Sirve para dos cosas: confirmar que el pestillo
 * responde siempre igual, y tocar el MOSFET y el solenoide después para
 * ver cuánto calientan en uso intensivo.
 */
void repetir() {
  Serial.println(F("\n=== 20 pulsos con 2 s de pausa ==="));
  for (uint8_t i = 1; i <= 20; i++) {
    Serial.printf("[%2u/20] ", i);
    pulso(msPulso);
    delay(2000);
  }
  Serial.println(F("Fin. Tocá el MOSFET y la bobina: tibios esta bien, quemando no."));
}

/** Reporta cambios del final de carrera, con antirrebote. */
void vigilarMicroswitch() {
  bool lectura = (digitalRead(PIN_MICROSWITCH) == HIGH);
  if (lectura == puertaAbierta) { ultimoCambio = millis(); return; }
  if (millis() - ultimoCambio < MS_ANTIRREBOTE) return;

  puertaAbierta = lectura;
  ultimoCambio = millis();
  Serial.printf("   [microswitch] puerta %s\n", puertaAbierta ? "ABIERTA" : "cerrada");
}
