/*
 * ============================================================
 *  GATEWAY DEL PAÑOL — Seeed XIAO ESP32S3 con ESP-NOW (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  Esta placa no piensa: es un cable. Traduce entre el USB (que lee gateway_serie.py en la
 *  PC) y la radio ESP-NOW, una línea JSON por trama.
 *
 *      PC  --USB-->  esta placa  --ESP-NOW-->  nodo
 *      PC  <--USB--  esta placa  <--ESP-NOW--  nodo
 *
 *  Toda la lógica (cola de comandos, reintentos, estados) vive en el backend. Si mañana
 *  cambian las reglas del pañol, esta placa no se toca.
 *
 *  El USB es el USB nativo de la XIAO (USB Serial/JTAG). El driver se instala para que la
 *  lectura sea bloqueante: fgets() espera una línea entera sin gastar CPU.
 *  Los logs del sistema salen por el mismo puerto; gateway_serie.py descarta toda línea
 *  que no sea JSON, y el nivel de log está en WARN (sdkconfig.defaults) para que molesten poco.
 *
 *  ⚠ El CANAL tiene que ser el mismo que el del nodo. Es la causa número uno de "no se
 *    escuchan": las dos placas inician bien, no da ningún error, y simplemente no se ven.
 * ============================================================
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_err.h"
#include "esp_mac.h"
#include "enlace_espnow.h"

#define CANAL     1
#define MAX_LINEA 300

/* Una línea JSON hacia la PC. Un solo printf: no se mezcla con un log de otra tarea. */
static void a_la_pc(const char *json)
{
    printf("%s\n", json);
    fflush(stdout);
}

static void consola_usb_iniciar(void)
{
    /* gateway_serie.py manda '\n'; el monitor de ESP-IDF, '\r' */
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_CR);
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF);
    fcntl(fileno(stdout), F_SETFL, 0);
    fcntl(fileno(stdin), F_SETFL, 0);

    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = 1024,
        .rx_buffer_size = 1024,
    };
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();        /* lectura y escritura bloqueantes, por interrupción */
    setvbuf(stdin, NULL, _IONBF, 0);
}

/* ---------- BAJADA: PC -> radio ---------- */
static void tarea_bajada(void *arg)
{
    static char linea[MAX_LINEA];
    for (;;) {
        if (fgets(linea, sizeof(linea), stdin) == NULL) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        size_t n = strcspn(linea, "\r\n");
        linea[n] = '\0';
        if (n == 0) continue;

        esp_err_t err = enlace_enviar(linea, n);
        if (err != ESP_OK) {
            char aviso[128];
            snprintf(aviso, sizeof(aviso), "{\"tipo\":\"error\",\"detalle\":\"no se pudo transmitir (%s)\"}",
                     esp_err_to_name(err));
            a_la_pc(aviso);
        }
    }
}

void app_main(void)
{
    consola_usb_iniciar();

    if (enlace_iniciar(CANAL) != ESP_OK) {
        /* Se avisa en JSON para que el script de la PC lo loguee igual que todo lo demás */
        a_la_pc("{\"tipo\":\"error\",\"detalle\":\"no se pudo iniciar ESP-NOW\"}");
        return;
    }

    uint8_t mac[6];
    enlace_mac(mac);
    char listo[128];
    snprintf(listo, sizeof(listo), "{\"tipo\":\"listo\",\"detalle\":\"gateway ESP-NOW canal %d\",\"mac\":\"" MACSTR "\"}",
             CANAL, MAC2STR(mac));
    a_la_pc(listo);

    xTaskCreate(tarea_bajada, "bajada", 4096, NULL, 5, NULL);

    /* ---------- SUBIDA: radio -> PC ---------- */
    /* Lo que llega por radio se reenvía tal cual: el gateway no interpreta el contenido */
    static enlace_trama_t trama;
    for (;;) {
        if (enlace_recibir(&trama, portMAX_DELAY)) {
            a_la_pc(trama.datos);
        }
    }
}
