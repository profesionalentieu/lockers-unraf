/*
 * ============================================================
 *  NODO DEL PAÑOL — Seeed XIAO ESP32S3 con ESP-NOW (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  Qué hace:
 *    1. Escucha por ESP-NOW las órdenes de apertura del gateway.
 *    2. Energiza el solenoide de esa puerta (bit del 74HC595 -> gate del IRLZ44N) durante
 *       el tiempo que pide la orden: 15 s por especificación. Lo hace la tarea de
 *       componentes/puertas, sin bloquear: mientras dura el pulso se siguen leyendo los
 *       microswitches y atendiendo otras puertas.
 *    3. Responde ACK con el mismo id APENAS arranca el pulso.
 *    4. Reporta cada cambio de microswitch, más un reporte completo periódico que
 *       resincroniza si se perdió algo, y un heartbeat.
 *
 *  Tramas (ver firmware/PROTOCOLO.md), JSON por difusión:
 *    recibe  {"id":12,"nodo":"NODO-A","bit":0,"accion":"ABRIR","ms":15000,"motivo":"RETIRO"}
 *    emite   {"tipo":"ack","id":12,"ok":true,"rssi":-52}
 *            {"tipo":"telemetria","nodo":"NODO-A","lecturas":[{"bit":0,"puertaAbierta":true}],"rssi":-52}
 *            {"tipo":"heartbeat","nodo":"NODO-A","rssi":-52,"bateriaMv":4000}
 *
 *  Este nodo no tiene secretos: no lleva config_local.h.
 * ============================================================
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "cJSON.h"
#include "enlace_espnow.h"
#include "puertas.h"

/* ---------- Identidad ---------- */
#define NODO_ID             "NODO-A"        /* tiene que coincidir con la tabla nodos */
#define CANT_PUERTAS        4
#define CANAL               1               /* el gateway tiene que usar el mismo */

/* ---------- Pines de la XIAO ESP32S3 (Dn = nombre en la placa) ---------- */
/* 74HC595: OE (pin 13) a GND y SRCLR (pin 10) a VCC. Pull-down de 10k en cada salida
   hacia el gate del MOSFET: al arrancar las salidas quedan indefinidas. */
#define PIN_SR_DATOS        GPIO_NUM_2      /* D1 -> SER   (pin 14) */
#define PIN_SR_RELOJ        GPIO_NUM_3      /* D2 -> SRCLK (pin 11) */
#define PIN_SR_LATCH        GPIO_NUM_4      /* D3 -> RCLK  (pin 12) */
/* Microswitches: COM a GND, NO al pin. A-01..A-04 = bit 0..3 del 595.
   ⚠ D6 y D7 son GPIO43/44, el TX/RX de la UART0: la ROM escribe en GPIO43 durante el
   arranque. Con la puerta cerrada (pin a GND) eso es un cortocircuito de ~100 ms.
   Poné 1 kΩ en serie en esos dos cables, o pasalos a D8/D9 (GPIO7/8) y cambiá acá. */
static const gpio_num_t PIN_MICROSWITCH[CANT_PUERTAS] = {
    GPIO_NUM_5,     /* D4 */
    GPIO_NUM_6,     /* D5 */
    GPIO_NUM_43,    /* D6 */
    GPIO_NUM_44,    /* D7 */
};

/* ---------- Tiempos ---------- */
#define MS_PULSO_DEFECTO    15000           /* si la orden no trae "ms" */
#define MAX_SIMULTANEOS     2               /* bobinas a la vez (fuente de 2 A) */
#define CORTAR_AL_ABRIR     false
#define MS_REPORTE_COMPLETO 60000
#define MS_HEARTBEAT        60000

static const char *TAG = "nodo";

static int64_t ahora_ms(void)
{
    return esp_timer_get_time() / 1000;
}

/* ============================================================
   TRAMAS QUE EMITE EL NODO
   ============================================================ */
static void enviar(const char *trama)
{
    esp_err_t err = enlace_enviar_texto(trama);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "No se pudo enviar (%s): %s", esp_err_to_name(err), trama);
    }
}

static void enviar_ack(uint32_t id, bool ok)
{
    char trama[96];
    snprintf(trama, sizeof(trama), "{\"tipo\":\"ack\",\"id\":%" PRIu32 ",\"ok\":%s,\"rssi\":%d}",
             id, ok ? "true" : "false", enlace_ultimo_rssi());
    enviar(trama);
}

/* Telemetría de las puertas cuyo bit está en `mascara`, con su estado actual */
static void enviar_telemetria(uint32_t mascara)
{
    char trama[ENLACE_MAX_DATOS + 1];
    int n = snprintf(trama, sizeof(trama), "{\"tipo\":\"telemetria\",\"nodo\":\"%s\",\"lecturas\":[", NODO_ID);
    bool primera = true;
    for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
        if (!(mascara & (1u << i))) continue;
        n += snprintf(trama + n, sizeof(trama) - n, "%s{\"bit\":%u,\"puertaAbierta\":%s}",
                      primera ? "" : ",", i, puertas_abierta(i) ? "true" : "false");
        primera = false;
    }
    snprintf(trama + n, sizeof(trama) - n, "],\"rssi\":%d}", enlace_ultimo_rssi());
    enviar(trama);
}

static void enviar_heartbeat(void)
{
    char trama[96];
    /* bateriaMv: reemplazar por la lectura real del divisor cuando lo haya */
    snprintf(trama, sizeof(trama), "{\"tipo\":\"heartbeat\",\"nodo\":\"%s\",\"rssi\":%d,\"bateriaMv\":4000}",
             NODO_ID, enlace_ultimo_rssi());
    enviar(trama);
}

/* ---------- Callbacks de puertas (corren en su tarea: solo mandan una trama) ---------- */
static void al_iniciar_pulso(uint8_t puerta, uint32_t id)
{
    enviar_ack(id, true);                   /* ACK = el pulso está en marcha */
}

static void al_cambiar_puerta(uint8_t puerta, bool abierta)
{
    enviar_telemetria(1u << puerta);
}

/* ============================================================
   TRAMAS QUE RECIBE EL NODO
   ============================================================ */
static void procesar(const enlace_trama_t *t)
{
    cJSON *doc = cJSON_Parse(t->datos);
    if (doc == NULL) return;                /* no es JSON: otra cosa en el mismo canal */

    /* El gateway difunde a todos los nodos: cada uno filtra lo suyo */
    const cJSON *nodo = cJSON_GetObjectItemCaseSensitive(doc, "nodo");
    const cJSON *accion = cJSON_GetObjectItemCaseSensitive(doc, "accion");
    if (!cJSON_IsString(nodo) || strcmp(nodo->valuestring, NODO_ID) != 0 || !cJSON_IsString(accion)) {
        cJSON_Delete(doc);
        return;
    }

    const cJSON *id = cJSON_GetObjectItemCaseSensitive(doc, "id");
    const cJSON *bit = cJSON_GetObjectItemCaseSensitive(doc, "bit");
    const cJSON *ms = cJSON_GetObjectItemCaseSensitive(doc, "ms");
    uint32_t nid = cJSON_IsNumber(id) ? (uint32_t)id->valuedouble : 0;
    int nbit = cJSON_IsNumber(bit) ? bit->valueint : -1;
    uint32_t nms = cJSON_IsNumber(ms) && ms->valuedouble > 0 ? (uint32_t)ms->valuedouble : MS_PULSO_DEFECTO;

    /* El campo "motivo" (RETIRO / DEVOLUCION) se ignora a propósito: sacar material y
       guardarlo son la MISMA acción física. */
    if (strcmp(accion->valuestring, "ABRIR") == 0 && nbit >= 0 && nbit < CANT_PUERTAS) {
        ESP_LOGI(TAG, "Orden #%" PRIu32 ": abrir puerta %d durante %" PRIu32 " ms (RSSI %d)", nid, nbit, nms, t->rssi);
        if (puertas_abrir((uint8_t)nbit, nid, nms) != ESP_OK) {
            ESP_LOGW(TAG, "No se pudo encolar la orden #%" PRIu32, nid);
        }
    } else if (strcmp(accion->valuestring, "PING") == 0) {
        enviar_ack(nid, true);
    }
    cJSON_Delete(doc);
}

static void tarea_radio(void *arg)
{
    const uint32_t todas = (1u << CANT_PUERTAS) - 1;
    int64_t ultimo_reporte = ahora_ms();
    int64_t ultimo_heartbeat = ahora_ms();
    enlace_trama_t trama;

    enviar_telemetria(todas);               /* estado inicial de las 4 puertas */
    for (;;) {
        if (enlace_recibir(&trama, pdMS_TO_TICKS(1000))) {
            procesar(&trama);
        }
        int64_t t = ahora_ms();
        if (t - ultimo_reporte >= MS_REPORTE_COMPLETO) {
            enviar_telemetria(todas);
            ultimo_reporte = t;
        }
        if (t - ultimo_heartbeat >= MS_HEARTBEAT) {
            enviar_heartbeat();
            ultimo_heartbeat = t;
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "=== Nodo del pañol UNRaf (ESP-NOW, ESP-IDF) · %s ===", NODO_ID);

    /* Primero la potencia: el registro queda en 0 antes que nada */
    puertas_config_t pcfg = PUERTAS_CONFIG_DEFECTO();
    pcfg.cantidad = CANT_PUERTAS;
    pcfg.tipo_salida = PUERTAS_SALIDA_595;
    pcfg.registro.datos = PIN_SR_DATOS;
    pcfg.registro.reloj = PIN_SR_RELOJ;
    pcfg.registro.latch = PIN_SR_LATCH;
    for (int i = 0; i < CANT_PUERTAS; i++) {
        pcfg.microswitch[i] = PIN_MICROSWITCH[i];
    }
    pcfg.max_simultaneos = MAX_SIMULTANEOS;
    pcfg.cortar_al_abrir = CORTAR_AL_ABRIR;
    pcfg.al_iniciar_pulso = al_iniciar_pulso;
    pcfg.al_cambiar_puerta = al_cambiar_puerta;
    ESP_ERROR_CHECK(puertas_iniciar(&pcfg));

    ESP_ERROR_CHECK(enlace_iniciar(CANAL));
    ESP_LOGI(TAG, "Escuchando en el canal %d como %s", CANAL, NODO_ID);

    xTaskCreate(tarea_radio, "radio", 6144, NULL, 5, NULL);
}
