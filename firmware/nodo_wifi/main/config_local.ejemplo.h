/*
 * Plantilla de config_local.h. Copiala como config_local.h (en esta misma carpeta, main/)
 * y completá la red y el backend.
 * config_local.h está en el .gitignore: nunca se sube al repositorio, que es público.
 */
#pragma once

/* Red WiFi de 2,4 GHz (el ESP32-C3 no usa 5 GHz). Sin portal de login. */
#define WIFI_SSID     "NOMBRE_DE_LA_RED"
#define WIFI_CLAVE    "CAMBIAR"

/* IP de la notebook donde corre el backend (la que da ipconfig), con el puerto y SIN barra final */
#define BACKEND_URL   "http://192.168.0.10:3000"

/* Tiene que ser igual a GATEWAY_API_KEY del .env del backend */
#define API_KEY       "gw-lora-unraf-2025"

/*
 * Potencia de transmisión en pasos de 0,25 dBm. 0 = la de fábrica.
 * La C3 SuperMini tiene la antena mal adaptada. Si no engancha la red o se reinicia al
 * conectar, probá 34 (8,5 dBm). Con una antena de alambre de 31 mm, la cátedra midió ~10 m
 * a través de una vidriera con 60 (15 dBm). No subas más con la antena puesta.
 */
#define POTENCIA_TX   0
