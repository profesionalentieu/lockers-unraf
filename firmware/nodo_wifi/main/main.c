/*
 * ============================================================
 *  NODO WiFi DEL PAÑOL — ESP32-C3 SuperMini, 4 lockers (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================
 *
 *  La placa habla HTTP directo con el backend por WiFi, sin gateway ni radio ESP-NOW.
 *  Mismos pines, mismos endpoints y mismos mensajes que la versión de Arduino
 *  (nodo_wifi_4.ino); lo que cambia es cómo se reparte el trabajo:
 *
 *   tarea "puertas"     (componentes/puertas) es la única que toca las salidas: energiza
 *                       cada solenoide los 15 s que pide el backend y lo apaga al vencer,
 *                       aunque la red esté colgada. Lee los microswitches cada 5 ms.
 *   tarea "comandos"    consulta GET /api/gateway/comandos cada 300 ms, le pasa cada orden a
 *                       puertas y manda el ACK cuando el pulso arranca de verdad.
 *   tarea "telemetria"  manda cada cambio de puerta (reintenta hasta que llega), el reporte
 *                       completo cada 60 s y el heartbeat cada 30 s.
 *
 *  Cada tarea de red tiene su propia conexión HTTP persistente (keep-alive): no se abre
 *  una conexión TCP nueva por pedido. WiFi sin ahorro de energía.
 *
 *  Red, IP del backend y API key: en config_local.h (no se sube al repositorio).
 *
 *  Endpoints (ver firmware/PROTOCOLO.md):
 *    GET  /api/gateway/comandos          -> {"comandos":[{"id","bit","ms","motivo","locker"}]}
 *    POST /api/gateway/comandos/:id/ack  {"ok":true}
 *    POST /api/gateway/telemetria        {"nodo","rssi","lecturas":[{"bit","puertaAbierta"}]}
 *    POST /api/gateway/heartbeat         {"nodo","rssi"}
 *  Todos con el header x-api-key.
 * ============================================================
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "puertas.h"

#if __has_include("config_local.h")
#include "config_local.h"
#else
#error "Falta main/config_local.h: copiá config_local.ejemplo.h como config_local.h y completá la red WiFi, la IP del backend y la API key"
#endif

#ifndef POTENCIA_TX
#define POTENCIA_TX 0
#endif

/* ============================================================
   CONFIGURACIÓN DEL GABINETE
   ============================================================ */
#define NODO_ID              "NODO-A"      /* tiene que coincidir con la tabla nodos */
#define CANT_PUERTAS         4

/* ESP32-C3 SuperMini. A-01..A-04 = bit 0..3.
   Se evitan GPIO2, 8 y 9 (pines de arranque) y 18/19 (el USB). */
static const gpio_num_t PIN_SOLENOIDE[CANT_PUERTAS]   = { GPIO_NUM_0, GPIO_NUM_1, GPIO_NUM_3, GPIO_NUM_4 };
static const gpio_num_t PIN_MICROSWITCH[CANT_PUERTAS] = { GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_10 };

#define MS_PULSO_DEFECTO     15000         /* si la orden no trae "ms" */
#define MAX_SIMULTANEOS      2             /* bobinas energizadas a la vez (fuente de 2 A) */
#define CORTAR_AL_ABRIR      false         /* true: corta apenas el switch confirma la apertura */

#define MS_ENTRE_CONSULTAS   300           /* cada cuánto se preguntan comandos */
#define MS_HEARTBEAT         30000
#define MS_REPORTE_COMPLETO  60000
#define MS_REINTENTO         300           /* si un reporte de puerta falla */
#define MS_TIMEOUT_HTTP      3000
#define MS_RECONEXION_WIFI   2000
#define TAM_RESPUESTA        2048

static const char *TAG = "nodo_wifi";

/* ============================================================
   ESTADO COMPARTIDO ENTRE TAREAS
   ============================================================ */
#define WIFI_CONECTADO BIT0
static EventGroupHandle_t eventos_wifi;
static QueueHandle_t cola_acks;            /* ids de comandos cuyo pulso ya arrancó */
static TaskHandle_t tarea_tel;             /* se le avisa cada cambio de puerta */
static esp_timer_handle_t timer_reconexion;

static int64_t ahora_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static bool wifi_conectado(void)
{
    return (xEventGroupGetBits(eventos_wifi) & WIFI_CONECTADO) != 0;
}

static int rssi_actual(void)
{
    wifi_ap_record_t ap;
    return esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;
}

/* ============================================================
   WiFi: conexión y reconexión
   ============================================================ */
static void reconectar(void *arg)
{
    esp_wifi_connect();
}

static void al_evento_wifi(void *arg, esp_event_base_t base, int32_t id, void *datos)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "Conectando a \"%s\"...", WIFI_SSID);
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *d = datos;
        xEventGroupClearBits(eventos_wifi, WIFI_CONECTADO);
        ESP_LOGW(TAG, "Sin WiFi (motivo %d). Reintento en %d s", d->reason, MS_RECONEXION_WIFI / 1000);
        /* No se reintenta en el acto: con la clave mal, eso inunda el monitor */
        esp_timer_stop(timer_reconexion);
        esp_timer_start_once(timer_reconexion, (uint64_t)MS_RECONEXION_WIFI * 1000);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = datos;
        ESP_LOGI(TAG, "[OK] Conectado. IP " IPSTR " | RSSI %d dBm | backend %s",
                 IP2STR(&e->ip_info.ip), rssi_actual(), BACKEND_URL);
        xEventGroupSetBits(eventos_wifi, WIFI_CONECTADO);
    }
}

static void wifi_iniciar(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, al_evento_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, al_evento_wifi, NULL));

    const esp_timer_create_args_t args = { .callback = reconectar, .name = "reconexion" };
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer_reconexion));

    wifi_config_t wcfg = { 0 };
    strlcpy((char *)wcfg.sta.ssid, WIFI_SSID, sizeof(wcfg.sta.ssid));
    strlcpy((char *)wcfg.sta.password, WIFI_CLAVE, sizeof(wcfg.sta.password));
    /* Red abierta si no hay clave; si no, WPA2 o mejor (el hotspot del celular, el router) */
    wcfg.sta.threshold.authmode = strlen(WIFI_CLAVE) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wcfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;

    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));   /* la red sale de config_local.h, no de la NVS */
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_country_code("AR", false));   /* canales 1 a 13 */
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    /* Sin ahorro de energía: cada pedido sale y vuelve al instante */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
#if POTENCIA_TX > 0
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(POTENCIA_TX));
    ESP_LOGI(TAG, "Potencia de transmisión: %.2f dBm", POTENCIA_TX / 4.0);
#endif
}

/* ============================================================
   HTTP: una conexión persistente por tarea
   ============================================================ */
typedef struct {
    esp_http_client_handle_t cliente;
    char respuesta[TAM_RESPUESTA];
    int largo;
} conexion_t;

/* Junta el cuerpo de la respuesta (puede llegar en varios pedazos) */
static esp_err_t al_evento_http(esp_http_client_event_t *e)
{
    conexion_t *c = e->user_data;
    if (e->event_id == HTTP_EVENT_ON_DATA && c != NULL && e->data_len > 0) {
        int libre = (int)sizeof(c->respuesta) - 1 - c->largo;
        int n = e->data_len < libre ? e->data_len : libre;
        if (n > 0) {
            memcpy(c->respuesta + c->largo, e->data, n);
            c->largo += n;
        }
    }
    return ESP_OK;
}

static void conexion_crear(conexion_t *c)
{
    const esp_http_client_config_t cfg = {
        .url = BACKEND_URL "/api/gateway/heartbeat",   /* se cambia en cada pedido */
        .timeout_ms = MS_TIMEOUT_HTTP,
        .event_handler = al_evento_http,
        .user_data = c,
        .disable_auto_redirect = true,
        .buffer_size = 1024,
        .buffer_size_tx = 1024,
    };
    c->cliente = esp_http_client_init(&cfg);
    ESP_ERROR_CHECK(c->cliente != NULL ? ESP_OK : ESP_ERR_NO_MEM);
    esp_http_client_set_header(c->cliente, "x-api-key", API_KEY);
}

/*
 * GET si cuerpo == NULL; POST con JSON si no. Devuelve el código HTTP (y la respuesta queda
 * en c->respuesta) o -1 si falló la red. Si la conexión vieja estaba muerta (el servidor la
 * cierra a los 5 s quieta), se descarta y se prueba una vez con una nueva.
 */
static int pedido(conexion_t *c, const char *ruta, const char *cuerpo)
{
    char url[192];
    snprintf(url, sizeof(url), "%s%s", BACKEND_URL, ruta);

    for (int intento = 0; intento < 2; intento++) {
        c->largo = 0;
        c->respuesta[0] = '\0';
        esp_http_client_set_url(c->cliente, url);
        if (cuerpo != NULL) {
            esp_http_client_set_method(c->cliente, HTTP_METHOD_POST);
            esp_http_client_set_header(c->cliente, "Content-Type", "application/json");
            esp_http_client_set_post_field(c->cliente, cuerpo, (int)strlen(cuerpo));
        } else {
            esp_http_client_set_method(c->cliente, HTTP_METHOD_GET);
            esp_http_client_delete_header(c->cliente, "Content-Type");
            esp_http_client_set_post_field(c->cliente, NULL, 0);
        }

        esp_err_t err = esp_http_client_perform(c->cliente);
        if (err == ESP_OK) {
            c->respuesta[c->largo] = '\0';
            return esp_http_client_get_status_code(c->cliente);
        }
        ESP_LOGW(TAG, "%s %s -> %s", cuerpo ? "POST" : "GET", ruta, esp_err_to_name(err));
        esp_http_client_close(c->cliente);
    }
    return -1;
}

/* ============================================================
   COMANDOS (aperturas que pide el backend)
   ============================================================ */

/* Callback de puertas: el pulso arrancó. Corre en la tarea de puertas, así que solo encola. */
static void al_iniciar_pulso(uint8_t puerta, uint32_t id)
{
    if (xQueueSend(cola_acks, &id, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Cola de ACK llena: el backend va a reintentar el comando #%" PRIu32, id);
    }
}

static void confirmar(conexion_t *c, uint32_t id, bool ok, const char *detalle)
{
    char ruta[48];
    char cuerpo[128];
    snprintf(ruta, sizeof(ruta), "/api/gateway/comandos/%" PRIu32 "/ack", id);
    if (detalle != NULL) {
        snprintf(cuerpo, sizeof(cuerpo), "{\"ok\":%s,\"detalle\":\"%s\"}", ok ? "true" : "false", detalle);
    } else {
        snprintf(cuerpo, sizeof(cuerpo), "{\"ok\":%s}", ok ? "true" : "false");
    }

    for (int intento = 1; intento <= 3; intento++) {
        int codigo = pedido(c, ruta, cuerpo);
        if (codigo >= 200 && codigo < 300) {
            ESP_LOGI(TAG, "<- ACK enviado #%" PRIu32, id);
            return;
        }
        if (codigo > 0) {      /* el servidor respondió (ej. 404): reintentar no cambia nada */
            ESP_LOGW(TAG, "ACK #%" PRIu32 " -> HTTP %d %s", id, codigo, c->respuesta);
            return;
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

static void consultar_comandos(conexion_t *c)
{
    int codigo = pedido(c, "/api/gateway/comandos", NULL);
    if (codigo != 200) {
        if (codigo > 0) ESP_LOGW(TAG, "GET /api/gateway/comandos -> HTTP %d %s", codigo, c->respuesta);
        return;
    }

    cJSON *raiz = cJSON_Parse(c->respuesta);
    if (raiz == NULL) {
        ESP_LOGW(TAG, "Respuesta de comandos que no es JSON");
        return;
    }
    const cJSON *comando;
    cJSON_ArrayForEach(comando, cJSON_GetObjectItemCaseSensitive(raiz, "comandos")) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(comando, "id");
        const cJSON *bit = cJSON_GetObjectItemCaseSensitive(comando, "bit");
        const cJSON *ms = cJSON_GetObjectItemCaseSensitive(comando, "ms");
        const cJSON *accion = cJSON_GetObjectItemCaseSensitive(comando, "accion");
        const cJSON *motivo = cJSON_GetObjectItemCaseSensitive(comando, "motivo");
        const cJSON *locker = cJSON_GetObjectItemCaseSensitive(comando, "locker");
        if (!cJSON_IsNumber(id)) continue;

        uint32_t nid = (uint32_t)id->valuedouble;
        int nbit = cJSON_IsNumber(bit) ? bit->valueint : -1;
        uint32_t nms = cJSON_IsNumber(ms) && ms->valuedouble > 0 ? (uint32_t)ms->valuedouble : MS_PULSO_DEFECTO;
        ESP_LOGI(TAG, "-> COMANDO #%" PRIu32 " para %s (bit %d, %" PRIu32 " ms, motivo %s)", nid,
                 cJSON_IsString(locker) ? locker->valuestring : "?", nbit, nms,
                 cJSON_IsString(motivo) ? motivo->valuestring : "-");

        if (cJSON_IsString(accion) && strcmp(accion->valuestring, "PING") == 0) {
            confirmar(c, nid, true, "pong");
        } else if (nbit >= 0 && nbit < CANT_PUERTAS) {
            /* El "motivo" (RETIRO / DEVOLUCION / EMERGENCIA) se ignora a propósito:
               sacar material y guardarlo son la MISMA acción física. El ACK sale cuando
               el pulso arranca (al_iniciar_pulso). */
            if (puertas_abrir((uint8_t)nbit, nid, nms) != ESP_OK) {
                ESP_LOGW(TAG, "No se pudo encolar el comando #%" PRIu32 ": el backend lo reintenta", nid);
            }
        } else {
            ESP_LOGW(TAG, "   (bit %d fuera de rango: se confirma sin accionar)", nbit);
            confirmar(c, nid, true, "casillero no cableado");
        }
    }
    cJSON_Delete(raiz);
}

static void tarea_comandos(void *arg)
{
    static conexion_t c;
    conexion_crear(&c);
    int64_t proxima_consulta = 0;

    for (;;) {
        xEventGroupWaitBits(eventos_wifi, WIFI_CONECTADO, pdFALSE, pdTRUE, portMAX_DELAY);

        if (ahora_ms() >= proxima_consulta) {
            consultar_comandos(&c);
            proxima_consulta = ahora_ms() + MS_ENTRE_CONSULTAS;
        }
        /* Mientras llega la próxima consulta, se mandan los ACK de los pulsos que arrancaron */
        int64_t falta = proxima_consulta - ahora_ms();
        uint32_t id;
        if (xQueueReceive(cola_acks, &id, falta > 0 ? pdMS_TO_TICKS(falta) : 0) == pdTRUE) {
            confirmar(&c, id, true, NULL);
        }
    }
}

/* ============================================================
   TELEMETRÍA (microswitches) Y HEARTBEAT
   ============================================================ */

/* Callback de puertas: cambió un microswitch. Solo avisa; el POST lo hace la tarea. */
static void al_cambiar_puerta(uint8_t puerta, bool abierta)
{
    if (tarea_tel != NULL) {
        xTaskNotify(tarea_tel, 1u << puerta, eSetBits);
    }
}

/* Manda en un solo POST todas las puertas pendientes, con su estado ACTUAL. */
static bool enviar_pendientes(conexion_t *c, uint32_t *pendientes)
{
    char cuerpo[256];
    int n = snprintf(cuerpo, sizeof(cuerpo), "{\"nodo\":\"%s\",\"rssi\":%d,\"lecturas\":[", NODO_ID, rssi_actual());
    uint32_t incluidas = 0;
    for (uint8_t i = 0; i < CANT_PUERTAS; i++) {
        if (!(*pendientes & (1u << i))) continue;
        n += snprintf(cuerpo + n, sizeof(cuerpo) - n, "%s{\"bit\":%u,\"puertaAbierta\":%s}",
                      incluidas ? "," : "", i, puertas_abierta(i) ? "true" : "false");
        incluidas |= 1u << i;
    }
    snprintf(cuerpo + n, sizeof(cuerpo) - n, "]}");

    int64_t inicio = ahora_ms();
    int codigo = pedido(c, "/api/gateway/telemetria", cuerpo);
    if (codigo >= 200 && codigo < 300) {
        *pendientes &= ~incluidas;
        ESP_LOGI(TAG, "<- telemetría OK: %d puerta(s) en %" PRId64 " ms",
                 __builtin_popcount(incluidas), ahora_ms() - inicio);
        return true;
    }
    ESP_LOGW(TAG, "POST telemetría -> HTTP %d %s (se reintenta)", codigo, c->respuesta);
    return false;
}

static void enviar_heartbeat(conexion_t *c)
{
    char cuerpo[64];
    snprintf(cuerpo, sizeof(cuerpo), "{\"nodo\":\"%s\",\"rssi\":%d}", NODO_ID, rssi_actual());
    int codigo = pedido(c, "/api/gateway/heartbeat", cuerpo);
    if (codigo < 200 || codigo >= 300) {
        ESP_LOGW(TAG, "POST heartbeat -> HTTP %d", codigo);
    }
}

static void tarea_telemetria(void *arg)
{
    static conexion_t c;
    conexion_crear(&c);
    const uint32_t todas = (1u << CANT_PUERTAS) - 1;
    uint32_t pendientes = todas;               /* al arrancar se sincronizan las 4 puertas */
    int64_t ultimo_reporte = ahora_ms();
    int64_t ultimo_heartbeat = ahora_ms();
    bool fallo = false;

    for (;;) {
        TickType_t espera;
        if (!wifi_conectado()) espera = pdMS_TO_TICKS(1000);
        else if (pendientes) espera = fallo ? pdMS_TO_TICKS(MS_REINTENTO) : 0;
        else espera = pdMS_TO_TICKS(1000);

        uint32_t avisos = 0;
        if (xTaskNotifyWait(0, UINT32_MAX, &avisos, espera) == pdTRUE) {
            pendientes |= avisos;
        }

        int64_t t = ahora_ms();
        /* Reporte completo periódico: resincroniza el tablero si se perdió un cambio */
        if (t - ultimo_reporte >= MS_REPORTE_COMPLETO) {
            pendientes |= todas;
            ultimo_reporte = t;
        }
        if (!wifi_conectado()) continue;

        if (pendientes) {
            fallo = !enviar_pendientes(&c, &pendientes);
        } else if (t - ultimo_heartbeat >= MS_HEARTBEAT) {
            enviar_heartbeat(&c);
            ultimo_heartbeat = t;
        }
    }
}

/* ============================================================
   ARRANQUE
   ============================================================ */
void app_main(void)
{
    esp_err_t err = nvs_flash_init();          /* el WiFi guarda la calibración en la NVS */
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_LOGI(TAG, "=== NODO %s · %d LOCKERS (ESP32-C3 SuperMini, ESP-IDF) ===", NODO_ID, CANT_PUERTAS);
    for (int i = 0; i < CANT_PUERTAS; i++) {
        ESP_LOGI(TAG, "Locker A-%02d: solenoide GPIO%d, microswitch GPIO%d", i + 1, PIN_SOLENOIDE[i], PIN_MICROSWITCH[i]);
    }

    eventos_wifi = xEventGroupCreate();
    cola_acks = xQueueCreate(16, sizeof(uint32_t));
    assert(eventos_wifi != NULL && cola_acks != NULL);

    /* Primero la potencia: las salidas quedan en 0 antes de cualquier otra cosa */
    puertas_config_t pcfg = PUERTAS_CONFIG_DEFECTO();
    pcfg.cantidad = CANT_PUERTAS;
    pcfg.tipo_salida = PUERTAS_SALIDA_GPIO;
    for (int i = 0; i < CANT_PUERTAS; i++) {
        pcfg.solenoide[i] = PIN_SOLENOIDE[i];
        pcfg.microswitch[i] = PIN_MICROSWITCH[i];
    }
    pcfg.max_simultaneos = MAX_SIMULTANEOS;
    pcfg.cortar_al_abrir = CORTAR_AL_ABRIR;
    pcfg.al_iniciar_pulso = al_iniciar_pulso;
    pcfg.al_cambiar_puerta = al_cambiar_puerta;
    ESP_ERROR_CHECK(puertas_iniciar(&pcfg));

    wifi_iniciar();

    xTaskCreate(tarea_telemetria, "telemetria", 6144, NULL, 5, &tarea_tel);
    xTaskCreate(tarea_comandos, "comandos", 6144, NULL, 5, NULL);
}
