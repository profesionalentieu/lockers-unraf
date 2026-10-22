/*
 * puertas — ver include/puertas.h.
 *
 * Una sola tarea es dueña de las salidas: recibe las órdenes por una cola, apaga lo que
 * venció, arranca lo que espera y lee los microswitches. Así no hace falta ningún candado
 * sobre el registro ni sobre los GPIO, y ningún pedido HTTP o trama de radio puede demorar
 * el corte de una bobina.
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "puertas.h"

static const char *TAG = "puertas";

#define PERIODO_MS        5       /* cada cuánto se revisan pulsos y microswitches */
#define LARGO_COLA        16
#define PRIORIDAD_TAREA   6       /* por encima de las tareas de red de la aplicación */

typedef struct {
    uint8_t puerta;
    uint32_t id;
    uint32_t ms;
} orden_t;

static puertas_config_t cfg;
static QueueHandle_t cola;

/* Solo los toca la tarea de puertas */
static uint8_t salidas;                         /* bit i = bobina i energizada */
static int64_t pulso_hasta[PUERTAS_MAX];        /* ms de esp_timer en que se corta */
static int64_t ultimo_arranque;
static struct {
    bool pendiente;
    uint32_t id;
    uint32_t ms;
} espera[PUERTAS_MAX];
static int64_t distinto_desde[PUERTAS_MAX];     /* desde cuándo el pin lee distinto */

/* Copias para consultar desde otras tareas (un byte o un bool: lectura atómica) */
static volatile uint8_t energizadas;
static volatile bool abierta[PUERTAS_MAX];

static int64_t ahora_ms(void)
{
    return esp_timer_get_time() / 1000;          /* 64 bits: no da la vuelta como millis() */
}

/* ---------- Potencia ---------- */

/* Vuelca la máscara a las salidas. En el 595: bit i -> Qi (se manda primero el bit 7). */
static void escribir(uint8_t mascara)
{
    if (cfg.tipo_salida == PUERTAS_SALIDA_GPIO) {
        for (uint8_t i = 0; i < cfg.cantidad; i++) {
            gpio_set_level(cfg.solenoide[i], (mascara >> i) & 1);
        }
        return;
    }
    gpio_set_level(cfg.registro.latch, 0);
    for (int bit = 7; bit >= 0; bit--) {
        gpio_set_level(cfg.registro.datos, (mascara >> bit) & 1);
        gpio_set_level(cfg.registro.reloj, 1);
        esp_rom_delay_us(1);                     /* margen para cables largos */
        gpio_set_level(cfg.registro.reloj, 0);
    }
    gpio_set_level(cfg.registro.latch, 1);       /* flanco de subida: pasa a las salidas */
}

static void avisar_pulso(uint8_t puerta, uint32_t id)
{
    if (cfg.al_iniciar_pulso != NULL) {
        cfg.al_iniciar_pulso(puerta, id);
    }
}

static uint32_t acotar(uint32_t ms)
{
    if (ms < cfg.ms_pulso_min) return cfg.ms_pulso_min;
    if (ms > cfg.ms_pulso_max) return cfg.ms_pulso_max;
    return ms;
}

static void recibir(const orden_t *o)
{
    if (o->puerta >= cfg.cantidad) {
        ESP_LOGW(TAG, "Orden #%lu para la puerta %u, que no existe", (unsigned long)o->id, o->puerta);
        return;
    }
    uint32_t ms = acotar(o->ms);
    if (salidas & (1u << o->puerta)) {
        /* Ya está energizada: es un reintento del backend (se perdió el ACK) o una orden
           nueva mientras dura el pulso. Se extiende y se vuelve a confirmar. */
        pulso_hasta[o->puerta] = ahora_ms() + ms;
        avisar_pulso(o->puerta, o->id);
        return;
    }
    /* Si ya había una esperando para esa puerta, la reemplaza: el backend reintenta con el mismo id. */
    espera[o->puerta].pendiente = true;
    espera[o->puerta].id = o->id;
    espera[o->puerta].ms = ms;
}

static void atender_pulsos(void)
{
    int64_t t = ahora_ms();

    /* 1. Apagar lo que venció. La salida vuelve a cero SIEMPRE:
          energizado de más, el solenoide se calienta y termina quemándose. */
    uint8_t antes = salidas;
    for (uint8_t i = 0; i < cfg.cantidad; i++) {
        uint8_t bit = 1u << i;
        if (!(salidas & bit)) continue;
        if (t >= pulso_hasta[i] || (cfg.cortar_al_abrir && abierta[i])) {
            salidas &= ~bit;
            ESP_LOGI(TAG, "Puerta %u: fin del pulso", i);
        }
    }
    if (salidas != antes) {
        escribir(salidas);
    }

    /* 2. Arrancar la próxima que espera, si hay lugar y ya pasó el pico anterior. */
    uint8_t activas = (uint8_t)__builtin_popcount(salidas);
    if (activas < cfg.max_simultaneos && (t - ultimo_arranque) >= cfg.ms_entre_arranques) {
        for (uint8_t i = 0; i < cfg.cantidad; i++) {
            if (!espera[i].pendiente) continue;
            espera[i].pendiente = false;
            salidas |= (1u << i);
            escribir(salidas);
            pulso_hasta[i] = t + espera[i].ms;
            ultimo_arranque = t;
            ESP_LOGI(TAG, "Puerta %u: solenoide energizado %lu ms (comando #%lu)",
                     i, (unsigned long)espera[i].ms, (unsigned long)espera[i].id);
            avisar_pulso(i, espera[i].id);      /* ACK = el pulso está en marcha */
            break;                               /* de a un arranque por vuelta */
        }
    }
    energizadas = salidas;
}

/* ---------- Microswitches ---------- */

/* Antirrebote: el cambio cuenta recién cuando el pin lee distinto durante ms_antirrebote. */
static void revisar_switches(void)
{
    int64_t t = ahora_ms();
    for (uint8_t i = 0; i < cfg.cantidad; i++) {
        bool lectura = gpio_get_level(cfg.microswitch[i]) == 1;     /* HIGH = abierta */
        if (lectura == abierta[i]) {
            distinto_desde[i] = t;
            continue;
        }
        if (t - distinto_desde[i] < cfg.ms_antirrebote) continue;

        abierta[i] = lectura;
        distinto_desde[i] = t;
        ESP_LOGI(TAG, "Puerta %u -> %s", i, lectura ? "ABIERTA" : "cerrada");
        if (cfg.al_cambiar_puerta != NULL) {
            cfg.al_cambiar_puerta(i, lectura);
        }
    }
}

static void tarea_puertas(void *arg)
{
    const TickType_t periodo = pdMS_TO_TICKS(PERIODO_MS) > 0 ? pdMS_TO_TICKS(PERIODO_MS) : 1;
    orden_t o;
    for (;;) {
        /* Espera órdenes como mucho un período: una orden se atiende en el acto. */
        if (xQueueReceive(cola, &o, periodo) == pdTRUE) {
            recibir(&o);
            while (xQueueReceive(cola, &o, 0) == pdTRUE) {
                recibir(&o);
            }
        }
        atender_pulsos();
        revisar_switches();
    }
}

/* ---------- API ---------- */

static esp_err_t configurar_salida(gpio_num_t pin)
{
    /* En 0 ANTES de habilitarla como salida: sin esto, un solenoide puede dispararse
       solo al encender el equipo. (Igual hace falta el pull-down de 10k en cada gate.) */
    gpio_set_level(pin, 0);
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    return gpio_config(&io);
}

esp_err_t puertas_iniciar(const puertas_config_t *config)
{
    if (config == NULL || config->cantidad == 0 || config->cantidad > PUERTAS_MAX ||
        config->max_simultaneos == 0 || config->ms_pulso_min > config->ms_pulso_max) {
        return ESP_ERR_INVALID_ARG;
    }
    if (cola != NULL) {
        return ESP_ERR_INVALID_STATE;            /* ya iniciado */
    }
    cfg = *config;

    /* Salidas: todo apagado antes que nada */
    if (cfg.tipo_salida == PUERTAS_SALIDA_GPIO) {
        for (uint8_t i = 0; i < cfg.cantidad; i++) {
            ESP_RETURN_ON_ERROR(configurar_salida(cfg.solenoide[i]), TAG, "GPIO del solenoide %u", i);
        }
    } else {
        ESP_RETURN_ON_ERROR(configurar_salida(cfg.registro.datos), TAG, "pin SER del 595");
        ESP_RETURN_ON_ERROR(configurar_salida(cfg.registro.reloj), TAG, "pin SRCLK del 595");
        ESP_RETURN_ON_ERROR(configurar_salida(cfg.registro.latch), TAG, "pin RCLK del 595");
    }
    salidas = 0;
    escribir(0);

    /* Microswitches */
    uint64_t mascara = 0;
    for (uint8_t i = 0; i < cfg.cantidad; i++) {
        mascara |= 1ULL << cfg.microswitch[i];
    }
    gpio_config_t io = {
        .pin_bit_mask = mascara,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "GPIO de los microswitches");
    esp_rom_delay_us(200);                       /* que el pull-up asiente antes de leer */

    int64_t t = ahora_ms();
    for (uint8_t i = 0; i < cfg.cantidad; i++) {
        abierta[i] = gpio_get_level(cfg.microswitch[i]) == 1;
        distinto_desde[i] = t;
        espera[i].pendiente = false;
        ESP_LOGI(TAG, "Puerta %u (switch GPIO%d): %s", i, cfg.microswitch[i], abierta[i] ? "ABIERTA" : "cerrada");
    }
    ultimo_arranque = t - cfg.ms_entre_arranques;

    cola = xQueueCreate(LARGO_COLA, sizeof(orden_t));
    if (cola == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreate(tarea_puertas, "puertas", 3072, NULL, PRIORIDAD_TAREA, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "%u puertas, salida por %s, hasta %u bobinas a la vez", cfg.cantidad,
             cfg.tipo_salida == PUERTAS_SALIDA_GPIO ? "GPIO" : "74HC595", cfg.max_simultaneos);
    return ESP_OK;
}

esp_err_t puertas_abrir(uint8_t puerta, uint32_t id, uint32_t ms)
{
    if (cola == NULL) return ESP_ERR_INVALID_STATE;
    if (puerta >= cfg.cantidad) return ESP_ERR_INVALID_ARG;
    orden_t o = { .puerta = puerta, .id = id, .ms = ms };
    return xQueueSend(cola, &o, pdMS_TO_TICKS(100)) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
}

bool puertas_abierta(uint8_t puerta)
{
    return puerta < cfg.cantidad && abierta[puerta];
}

bool puertas_energizada(uint8_t puerta)
{
    return puerta < cfg.cantidad && (energizadas & (1u << puerta));
}

uint8_t puertas_cantidad(void)
{
    return cfg.cantidad;
}
