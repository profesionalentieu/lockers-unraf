/*
 * ============================================================
 *  PRUEBA DE ACTUADOR — un solenoide + un microswitch (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  PARA QUÉ SIRVE
 *  Validar toda la etapa de potencia SIN el registro de desplazamiento y SIN radio: un
 *  MOSFET colgado de un pin del micro. Responde dos preguntas:
 *
 *    ¿Cuántos milisegundos de pulso necesita la cerradura para soltar?  (comando b)
 *    ¿Cuánto calienta la bobina con el pulso de servicio de 15 s?       (comando v)
 *
 *  El primer número es el MÍNIMO que tiene que garantizar la fuente. En servicio la
 *  cerradura queda energizada 15 s, la ventana que tiene la persona para tirar de la puerta.
 *
 *  CONEXIONADO (una sola puerta)
 *
 *     12 V ──┬────────────────┐
 *            │            [solenoide]
 *          [1N4007]           │        <- cátodo (la franja) ARRIBA
 *     (franja al +12 V)       │
 *            └────────────────┤
 *                          DRAIN
 *     PIN_GATE ───[gate]   IRLZ44N
 *                    │     SOURCE
 *                [10 kΩ]      │
 *     GND ───────────┴────────┴───── al GND de la placa (MASA COMÚN)
 *
 *     Microswitch:  COM ── GND      NO ── PIN_MICROSWITCH
 *     Puerta cerrada = palanca apretada = LOW. Un cable cortado lee ABIERTA (estado seguro).
 *
 *  ⚠ TRES COSAS QUE QUEMAN EL CIRCUITO
 *   1. Sin el diodo flyback, el pico inverso de la bobina mata al MOSFET.
 *   2. Sin masa común entre la fuente de 12 V y la placa, el gate no tiene referencia.
 *   3. Nunca conectes el solenoide directo a un pin: un GPIO da ~20 mA y el solenoide pide 600.
 *
 *  CÓMO USARLO
 *  "ESP-IDF: Monitor Device". Comandos (una letra y Enter):
 *      p        pulso con la duración actual
 *      + / -    subir o bajar la duración en 50 ms
 *      b        barrido: prueba de 100 a 800 ms para encontrar el mínimo
 *      s        estado del microswitch
 *      r        20 pulsos seguidos (prueba de calentamiento)
 *      v        pulso de SERVICIO: 15 s, como lo manda el backend, e informa a los
 *               cuántos ms se abrió la puerta
 * ============================================================
 */
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_timer.h"

/* ---------- Pines según la placa (el target se elige al compilar) ---------- */
#if CONFIG_IDF_TARGET_ESP32S3
/* XIAO ESP32S3: los mismos que usa el nodo (D1 = salida del 595 en el gabinete) */
#define PLACA           "XIAO ESP32S3"
#define PIN_GATE        GPIO_NUM_2      /* D1 -> gate del IRLZ44N */
#define PIN_MICROSWITCH GPIO_NUM_5      /* D4 */
#elif CONFIG_IDF_TARGET_ESP32C3
/* ESP32-C3 SuperMini: los del locker A-01 de nodo_wifi */
#define PLACA           "ESP32-C3 SuperMini"
#define PIN_GATE        GPIO_NUM_0
#define PIN_MICROSWITCH GPIO_NUM_5
#else
#error "Elegí el target: esp32s3 (XIAO) o esp32c3 (SuperMini) con ESP-IDF: Set Espressif Device Target"
#endif

/* ---------- Parámetros ---------- */
#define MS_MINIMO          50
#define MS_MAXIMO          1500         /* más que esto calienta la bobina al pedo */
#define MS_ANTIRREBOTE     50
#define MS_PULSO_SERVICIO  15000        /* = PULSO_APERTURA_SEG del backend */

static uint32_t ms_pulso = 400;         /* duración inicial del pulso */
static volatile bool puerta_abierta;    /* estado filtrado: lo actualiza tarea_microswitch */

static int64_t ahora_ms(void)
{
    return esp_timer_get_time() / 1000;
}

/* Reporta cambios del final de carrera, con antirrebote. */
static void tarea_microswitch(void *arg)
{
    int64_t distinto_desde = ahora_ms();
    for (;;) {
        bool lectura = gpio_get_level(PIN_MICROSWITCH) == 1;
        if (lectura == puerta_abierta) {
            distinto_desde = ahora_ms();
        } else if (ahora_ms() - distinto_desde >= MS_ANTIRREBOTE) {
            puerta_abierta = lectura;
            distinto_desde = ahora_ms();
            printf("   [microswitch] puerta %s\n", puerta_abierta ? "ABIERTA" : "cerrada");
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

/* Un pulso: energiza, espera, corta. La salida vuelve a cero SIEMPRE. */
static void pulso(uint32_t ms)
{
    printf("\n>> Pulso de %" PRIu32 " ms ... ", ms);
    fflush(stdout);
    int64_t t0 = ahora_ms();
    gpio_set_level(PIN_GATE, 1);
    vTaskDelay(pdMS_TO_TICKS(ms));
    gpio_set_level(PIN_GATE, 0);     /* imprescindible: energizado se calienta y se quema */

    vTaskDelay(pdMS_TO_TICKS(300));  /* un momento para que el switch acuse el movimiento */
    printf("listo (%" PRId64 " ms totales) -> microswitch dice %s\n",
           ahora_ms() - t0, gpio_get_level(PIN_MICROSWITCH) ? "ABIERTA" : "cerrada");
}

/* Lee un comando: la primera letra de la línea (Enter manda la línea). */
static int leer_comando(void)
{
    int c;
    do {
        c = getchar();
    } while (c == '\n' || c == '\r' || c == ' ' || c == EOF);
    int resto;
    while ((resto = getchar()) != '\n' && resto != EOF) {}   /* descarta el resto de la línea */
    return c;
}

static void esperar_enter(void)
{
    int c;
    while ((c = getchar()) != '\n' && c != EOF) {}
}

/* Barrido: busca la duración mínima que suelta el pestillo. */
static void barrido(void)
{
    printf("\n=== BARRIDO: de 100 a 800 ms ===\n");
    printf("Cerrá la puerta antes de cada intento. Enter para seguir.\n");
    for (uint32_t ms = 100; ms <= 800; ms += 100) {
        printf("\n-- Probando %" PRIu32 " ms. Enter cuando la puerta esté cerrada...\n", ms);
        esperar_enter();
        pulso(ms);
    }
    printf("\n=== Fin del barrido ===\n");
    printf("Tomá el valor mínimo que abrió SIEMPRE: es lo mínimo que tiene que sostener la fuente.\n");
}

/* 20 pulsos seguidos: confirma que el pestillo responde siempre igual, y después se toca el
   MOSFET y la bobina para ver cuánto calientan en uso intensivo. */
static void repetir(void)
{
    printf("\n=== 20 pulsos con 2 s de pausa ===\n");
    for (int i = 1; i <= 20; i++) {
        printf("[%2d/20] ", i);
        pulso(ms_pulso);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    printf("Fin. Tocá el MOSFET y la bobina: tibios está bien, quemando no.\n");
}

/* Pulso de servicio: lo mismo que hace el nodo cuando alguien valida su código. Repetilo
   5 veces seguidas y tocá la bobina: es el peor caso real. */
static void pulso_servicio(void)
{
    printf("\n>> Pulso de servicio: %d ms. Tirá de la puerta...\n", MS_PULSO_SERVICIO);
    bool cerrada_al_inicio = !puerta_abierta;
    int64_t t0 = ahora_ms();
    int64_t abrio_en = 0;
    gpio_set_level(PIN_GATE, 1);
    while (ahora_ms() - t0 < MS_PULSO_SERVICIO) {
        if (cerrada_al_inicio && puerta_abierta && abrio_en == 0) abrio_en = ahora_ms() - t0;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    gpio_set_level(PIN_GATE, 0);
    if (abrio_en) printf("Listo: la puerta se abrió a los %" PRId64 " ms del pulso.\n", abrio_en);
    else printf("Listo: la puerta NO se abrió (en el sistema real: 'Reintentar apertura').\n");
}

static void consola_usb_iniciar(void)
{
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_CR);    /* el monitor manda '\r' */
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_CRLF);
    fcntl(fileno(stdout), F_SETFL, 0);
    fcntl(fileno(stdin), F_SETFL, 0);
    usb_serial_jtag_driver_config_t cfg = { .tx_buffer_size = 512, .rx_buffer_size = 256 };
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();      /* getchar() bloquea hasta que llega una tecla */
    setvbuf(stdin, NULL, _IONBF, 0);
}

void app_main(void)
{
    /* El gate en bajo ANTES de configurarlo como salida: evita un pulso espurio en el
       arranque que dispare la cerradura sola. */
    gpio_set_level(PIN_GATE, 0);
    gpio_config_t salida = {
        .pin_bit_mask = 1ULL << PIN_GATE,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&salida));
    gpio_set_level(PIN_GATE, 0);

    gpio_config_t entrada = {
        .pin_bit_mask = 1ULL << PIN_MICROSWITCH,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&entrada));
    vTaskDelay(pdMS_TO_TICKS(1));
    puerta_abierta = gpio_get_level(PIN_MICROSWITCH) == 1;

    consola_usb_iniciar();
    xTaskCreate(tarea_microswitch, "microswitch", 3072, NULL, 5, NULL);

    printf("\n==================================================\n");
    printf("  Prueba de actuador - solenoide 12V (%s)\n", PLACA);
    printf("  Gate: GPIO%d · Microswitch: GPIO%d\n", PIN_GATE, PIN_MICROSWITCH);
    printf("==================================================\n");
    printf("  p      pulso\n");
    printf("  + / -  ajustar duración (50 ms)\n");
    printf("  b      barrido 100..800 ms (buscar el mínimo)\n");
    printf("  s      estado del microswitch\n");
    printf("  r      20 pulsos seguidos (calentamiento)\n");
    printf("  v      pulso de servicio de 15 s (especificación)\n");
    printf("==================================================\n");
    printf("  Duración actual: %" PRIu32 " ms\n", ms_pulso);
    printf("  Puerta: %s\n\n", puerta_abierta ? "ABIERTA" : "cerrada");

    for (;;) {
        switch (leer_comando()) {
        case 'p': pulso(ms_pulso); break;
        case '+':
            ms_pulso = ms_pulso + 50 > MS_MAXIMO ? MS_MAXIMO : ms_pulso + 50;
            printf("Duración: %" PRIu32 " ms\n", ms_pulso);
            break;
        case '-':
            ms_pulso = ms_pulso < MS_MINIMO + 50 ? MS_MINIMO : ms_pulso - 50;
            printf("Duración: %" PRIu32 " ms\n", ms_pulso);
            break;
        case 'b': barrido(); break;
        case 's':
            printf("Microswitch: %s (lectura %s)\n", puerta_abierta ? "puerta ABIERTA" : "puerta cerrada",
                   gpio_get_level(PIN_MICROSWITCH) ? "HIGH" : "LOW");
            break;
        case 'r': repetir(); break;
        case 'v': pulso_servicio(); break;
        default: printf("Comandos: p + - b s r v\n"); break;
        }
    }
}
