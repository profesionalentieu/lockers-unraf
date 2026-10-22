/*
 * enlace_espnow — la radio entre el gabinete y el gateway.
 *
 * Las tramas van por DIFUSIÓN (FF:FF:FF:FF:FF:FF) en los dos sentidos y cada placa filtra
 * por el campo "nodo": así no hay que grabar la MAC de nadie y las placas se intercambian
 * sin tocar el código. La difusión no tiene confirmación a nivel de enlace; la confiabilidad
 * la da el ACK de aplicación con reintentos que maneja el backend.
 *
 * Lo usan el nodo, el gateway y la prueba de enlace.
 *
 * ⚠ Todas las placas tienen que usar el MISMO canal: si difieren, arrancan sin error y
 *   simplemente no se ven.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_now.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ENLACE_MAX_DATOS ESP_NOW_MAX_DATA_LEN     /* 250 bytes por trama (ESP-NOW v1) */

typedef struct {
    uint8_t mac[6];                     /* quién la mandó */
    int rssi;                           /* potencia con que llegó, en dBm */
    size_t largo;
    char datos[ENLACE_MAX_DATOS + 1];   /* siempre terminado en '\0' */
} enlace_trama_t;

/* NVS + WiFi en modo estación (sin asociarse a ninguna red) + ESP-NOW en `canal`. */
esp_err_t enlace_iniciar(uint8_t canal);

/* Difunde una trama. Devuelve ESP_ERR_INVALID_SIZE si pasa de ENLACE_MAX_DATOS. */
esp_err_t enlace_enviar(const void *datos, size_t largo);
esp_err_t enlace_enviar_texto(const char *texto);

/* Espera una trama hasta `espera` ticks. Las tramas llegan en la tarea de WiFi y se
   copian a una cola: acá se procesan con calma, en la tarea de la aplicación. */
bool enlace_recibir(enlace_trama_t *trama, TickType_t espera);

/* RSSI de la última trama recibida (0 si todavía no llegó ninguna). */
int enlace_ultimo_rssi(void);

/* MAC de esta placa en modo estación (la que ven las demás). */
void enlace_mac(uint8_t mac[6]);

#ifdef __cplusplus
}
#endif
