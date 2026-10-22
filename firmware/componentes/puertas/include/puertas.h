/*
 * puertas — cerraduras (solenoides) y finales de carrera de un gabinete de lockers.
 *
 * Lo comparten los dos nodos (nodo_wifi y nodo ESP-NOW): cambia CÓMO llega la orden y
 * CÓMO se reporta el estado, pero el manejo de la potencia y de los microswitches es el
 * mismo. Por eso vive acá y no en cada main.c.
 *
 * Qué hace:
 *  - Energiza la cerradura de una puerta el tiempo que pide el backend (15 s por
 *    especificación) SIN bloquear: una tarea propia apaga cada salida cuando vence.
 *  - Cuida la fuente: como máximo `max_simultaneos` bobinas a la vez, y dos arranques
 *    separados por `ms_entre_arranques` (el pico de uno no se suma al del otro). Una orden
 *    que no entra espera su turno.
 *  - Lee los microswitches con antirrebote y avisa cada cambio.
 *
 * La salida hacia los MOSFET puede ser directa (un GPIO por puerta, como en la ESP32-C3
 * SuperMini) o por un registro 74HC595 (3 pines para 8 salidas, como en la XIAO ESP32S3).
 *
 * Los callbacks se ejecutan en la tarea de puertas: tienen que ser cortos y no bloquear
 * (encolar algo o mandar una trama ESP-NOW está bien; un pedido HTTP, no).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "driver/gpio.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PUERTAS_MAX 8

typedef enum {
    PUERTAS_SALIDA_GPIO,    /* un GPIO por puerta, directo al gate del MOSFET */
    PUERTAS_SALIDA_595,     /* registro de desplazamiento 74HC595 */
} puertas_tipo_salida_t;

/* Arrancó el pulso de una orden (o se extendió uno en curso): es el momento del ACK. */
typedef void (*puertas_pulso_cb_t)(uint8_t puerta, uint32_t id);

/* El microswitch de una puerta cambió (ya filtrado el rebote). */
typedef void (*puertas_cambio_cb_t)(uint8_t puerta, bool abierta);

typedef struct {
    uint8_t cantidad;                           /* puertas, de 1 a PUERTAS_MAX */

    /* Microswitch: COM a GND y NO al pin, con pull-up interno.
       Puerta cerrada = palanca apretada = LOW. Un cable cortado lee HIGH = abierta,
       que es el estado seguro. */
    gpio_num_t microswitch[PUERTAS_MAX];

    puertas_tipo_salida_t tipo_salida;
    gpio_num_t solenoide[PUERTAS_MAX];          /* solo PUERTAS_SALIDA_GPIO */
    struct {
        gpio_num_t datos;                       /* SER   (pin 14 del 74HC595) */
        gpio_num_t reloj;                       /* SRCLK (pin 11) */
        gpio_num_t latch;                       /* RCLK  (pin 12) */
    } registro;                                 /* solo PUERTAS_SALIDA_595 */

    uint8_t  max_simultaneos;                   /* bobinas energizadas a la vez */
    uint16_t ms_entre_arranques;                /* separa los picos de arranque */
    uint32_t ms_pulso_min;                      /* tope inferior de una orden */
    uint32_t ms_pulso_max;                      /* tope de seguridad para la bobina */
    uint16_t ms_antirrebote;
    /* La especificación pide los 15 s completos. Si la bobina calienta de más, en true
       corta apenas el switch confirma que la puerta se abrió. */
    bool cortar_al_abrir;

    puertas_pulso_cb_t  al_iniciar_pulso;       /* puede ser NULL */
    puertas_cambio_cb_t al_cambiar_puerta;      /* puede ser NULL */
} puertas_config_t;

/* Valores por defecto de la especificación; después se completan los pines. */
#define PUERTAS_CONFIG_DEFECTO()        \
    {                                   \
        .max_simultaneos = 2,           \
        .ms_entre_arranques = 300,      \
        .ms_pulso_min = 100,            \
        .ms_pulso_max = 20000,          \
        .ms_antirrebote = 50,           \
        .cortar_al_abrir = false,       \
    }

/* Configura los pines (todas las salidas en 0 ANTES de habilitarlas) y arranca la tarea. */
esp_err_t puertas_iniciar(const puertas_config_t *config);

/*
 * Pide un pulso de `ms` milisegundos en una puerta. Se puede llamar desde cualquier tarea.
 * Si esa puerta ya está energizada (un reintento del backend), se extiende el pulso y se
 * vuelve a avisar con al_iniciar_pulso. Si no, la orden espera su turno.
 */
esp_err_t puertas_abrir(uint8_t puerta, uint32_t id, uint32_t ms);

/* Estado filtrado del microswitch: true = puerta abierta. */
bool puertas_abierta(uint8_t puerta);

/* true mientras la bobina de esa puerta está energizada. */
bool puertas_energizada(uint8_t puerta);

uint8_t puertas_cantidad(void);

#ifdef __cplusplus
}
#endif
