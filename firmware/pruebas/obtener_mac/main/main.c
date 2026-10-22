/*
 * ============================================================
 *  OBTENER MAC — identificación de cada placa (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  ESP-NOW identifica a cada equipo por su dirección MAC, que viene grabada de fábrica y es
 *  única. Este programa la imprime cada 5 s (así la ves aunque abras el monitor tarde).
 *
 *  PARA QUÉ LA NECESITÁS
 *  El firmware del proyecto usa difusión, así que NO hace falta configurar ninguna MAC para
 *  que funcione. Pero anotarlas sirve igual:
 *    · Para etiquetar físicamente las placas y no confundirlas.
 *    · Para diagnosticar: en los logs se ve de qué placa vino cada trama.
 *    · Para el informe, y por si más adelante pasan a unicast.
 *    · Es la misma identidad que usa AURA: hw_id = mac-<MAC en minúsculas, sin ':'>.
 *
 *  No hace falta prender el WiFi: la MAC se lee del eFuse.
 * ============================================================
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_chip_info.h"
#include "esp_mac.h"

void app_main(void)
{
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));   /* la que usan ESP-NOW y el WiFi */

    esp_chip_info_t chip;
    esp_chip_info(&chip);

    for (;;) {
        printf("\n==================================================\n");
        printf("  Identificación de la placa (%s, revisión %d.%d)\n", CONFIG_IDF_TARGET,
               chip.revision / 100, chip.revision % 100);
        printf("==================================================\n");
        printf("  MAC (modo estación): " MACSTR "\n", MAC2STR(mac));
        printf("  Para el código C:    {0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X}\n",
               mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        printf("  hw_id (AURA):        mac-%02x%02x%02x%02x%02x%02x\n",
               mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        printf("==================================================\n");
        printf("  Anotá los últimos 4 dígitos y etiquetá la placa.\n");
        printf("  ESP-NOW: todas las placas tienen que usar el MISMO canal.\n");
        printf("==================================================\n");
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
