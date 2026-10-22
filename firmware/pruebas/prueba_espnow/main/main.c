/*
 * ============================================================
 *  PRUEBA DE ENLACE ESP-NOW — ping-pong con estadísticas (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  Una placa manda pings numerados, la otra los devuelve. La sonda mide el tiempo de ida y
 *  vuelta, la potencia recibida de cada lado y cuántos paquetes se perdieron.
 *
 *  Lo importante NO es confirmar que funciona (ESP-NOW casi siempre funciona en la mesa),
 *  sino MEDIR EL ALCANCE REAL en el edificio: a 2,4 GHz el hormigón atenúa mucho, y de eso
 *  depende dónde puede estar el gateway.
 *
 *  CÓMO USARLO
 *  1. En una placa dejá  #define ES_SONDA 1   (la que mide)
 *     En la otra poné    #define ES_SONDA 0   (la que responde)
 *  2. Monitor en la sonda ("ESP-IDF: Monitor Device").
 *  3. Alejate con la placa que responde y anotá el RSSI a cada distancia.
 *
 *  CÓMO LEER LOS NÚMEROS
 *    RSSI  potencia recibida en dBm. Menos negativo es mejor.
 *          -40 al lado · -70 bien · -85 al límite · -90 se corta
 *    RTT   ida y vuelta en ms. Esperá entre 2 y 15 ms.
 * ============================================================
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "enlace_espnow.h"

/* ---------- ROL: cambiar acá y volver a grabar en cada placa ---------- */
#define ES_SONDA 1

/* Canal WiFi. Las dos placas TIENEN que usar el mismo. */
#define CANAL 1

#define MS_ENTRE_PINGS      1000
#define MS_ESPERA_RESPUESTA 500      /* ESP-NOW responde en milisegundos */

#if ES_SONDA

static void separador(void)
{
    printf("----+--------+------------+-------------+---------\n");
}

static void sonda(void)
{
    uint32_t enviados = 0, recibidos = 0;
    int64_t suma_rtt_us = 0;
    int peor = 0, mejor = -200;
    enlace_trama_t t;

    printf("\nseq | RTT    | RSSI local | RSSI remoto | perdidos\n");
    separador();

    for (;;) {
        enviados++;
        char ping[32];
        snprintf(ping, sizeof(ping), "PING;%" PRIu32, enviados);

        while (enlace_recibir(&t, 0)) {}            /* descarta respuestas viejas */
        int64_t salida = esp_timer_get_time();
        enlace_enviar_texto(ping);

        /* Espera "PONG;<seq>;<rssi del otro extremo>" con el mismo número */
        bool llego = false;
        int rssi_remoto = 0, rssi_local = 0;
        int64_t rtt_us = 0;
        for (;;) {
            int64_t transcurrido_ms = (esp_timer_get_time() - salida) / 1000;
            if (transcurrido_ms >= MS_ESPERA_RESPUESTA) break;
            if (!enlace_recibir(&t, pdMS_TO_TICKS(MS_ESPERA_RESPUESTA - transcurrido_ms))) break;
            if (strncmp(t.datos, "PONG;", 5) != 0) continue;
            char *fin;
            uint32_t seq = strtoul(t.datos + 5, &fin, 10);
            if (seq != enviados || *fin != ';') continue;
            rtt_us = esp_timer_get_time() - salida;
            rssi_remoto = atoi(fin + 1);
            rssi_local = t.rssi;
            llego = true;
            break;
        }

        if (llego) {
            recibidos++;
            suma_rtt_us += rtt_us;
            if (rssi_local < peor || peor == 0) peor = rssi_local;
            if (rssi_local > mejor) mejor = rssi_local;
            printf("%3" PRIu32 " | %4.1f ms |   %4d dBm |    %4d dBm | %" PRIu32 "\n",
                   enviados, rtt_us / 1000.0, rssi_local, rssi_remoto, enviados - recibidos);
        } else {
            printf("%3" PRIu32 " |  ---   |    PERDIDO (sin respuesta)   | %" PRIu32 "\n",
                   enviados, enviados - recibidos);
        }

        if (enviados % 10 == 0) {
            double entrega = 100.0 * recibidos / enviados;
            separador();
            printf("RESUMEN: %" PRIu32 "/%" PRIu32 " entregados (%.0f%%) · RTT medio %.1f ms · RSSI entre %d y %d dBm\n",
                   recibidos, enviados, entrega, recibidos ? suma_rtt_us / 1000.0 / recibidos : 0.0, peor, mejor);
            if (entrega < 90) printf("  Pérdida alta: estás cerca del límite de alcance.\n");
            separador();
        }
        vTaskDelay(pdMS_TO_TICKS(MS_ENTRE_PINGS));
    }
}

#else

/* Devuelve cada ping con el RSSI que midió */
static void eco(void)
{
    enlace_trama_t t;
    printf("\nEsperando pings...\n");
    for (;;) {
        if (!enlace_recibir(&t, portMAX_DELAY)) continue;
        if (strncmp(t.datos, "PING;", 5) != 0) continue;
        const char *seq = t.datos + 5;
        printf("ping #%s recibido a %d dBm -> devolviendo\n", seq, t.rssi);
        char pong[48];
        snprintf(pong, sizeof(pong), "PONG;%.12s;%d", seq, t.rssi);
        enlace_enviar_texto(pong);
    }
}

#endif

void app_main(void)
{
    ESP_ERROR_CHECK(enlace_iniciar(CANAL));

    uint8_t mac[6];
    enlace_mac(mac);
    printf("\n==============================================\n");
    printf("  Prueba ESP-NOW - rol: %s\n", ES_SONDA ? "SONDA (mide)" : "ECO (responde)");
    printf("  MAC de esta placa: " MACSTR "\n", MAC2STR(mac));
    printf("  Canal: %d\n", CANAL);
    printf("==============================================\n");

#if ES_SONDA
    sonda();
#else
    eco();
#endif
}
