/**
 * ============================================================
 *  OBTENER MAC — identificación de cada placa
 *  Prototipo UNRaf · Ingeniería en Computación 3
 * ============================================================
 *
 *  ESP-NOW identifica a cada equipo por su dirección MAC, que viene
 *  grabada de fábrica y es única. Este sketch la imprime.
 *
 *  PARA QUÉ LA NECESITÁS
 *  El firmware del proyecto usa difusión (broadcast), así que NO hace
 *  falta configurar ninguna MAC para que funcione. Pero anotarlas sirve
 *  igual, y mucho:
 *    · Para etiquetar físicamente las placas y no confundirlas.
 *    · Para diagnosticar: en los logs se ve de qué placa vino cada trama.
 *    · Para el informe, y por si más adelante pasan a unicast.
 *
 *  CÓMO USARLO
 *  Cargalo en cada placa, monitor serie a 115200, y pegá una etiqueta
 *  con los últimos cuatro dígitos en cada una.
 * ============================================================
 */

#include <WiFi.h>
#include <esp_wifi.h>

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 5000) delay(10);
  delay(500);

  // ESP-NOW trabaja en modo estación, sin conectarse a ninguna red.
  WiFi.mode(WIFI_STA);

  Serial.println(F("\n=================================================="));
  Serial.println(F("  Identificacion de la placa"));
  Serial.println(F("=================================================="));
  Serial.print(F("  MAC (modo estacion): "));
  Serial.println(WiFi.macAddress());

  uint8_t mac[6];
  esp_wifi_get_mac(WIFI_IF_STA, mac);
  Serial.print(F("  Para el codigo C:    "));
  Serial.printf("{0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X}\n",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  Serial.printf("  Canal WiFi actual:   %d\n", WiFi.channel());
  Serial.println(F("=================================================="));
  Serial.println(F("  Anota los ultimos 4 digitos y etiqueta la placa."));
  Serial.println(F("  Las dos placas tienen que quedar en el MISMO canal."));
  Serial.println(F("=================================================="));
}

void loop() {
  delay(10000);
}
