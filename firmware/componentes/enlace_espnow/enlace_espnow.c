/*
 * enlace_espnow — ver include/enlace_espnow.h.
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "enlace_espnow.h"

static const char *TAG = "enlace";

#define LARGO_COLA 8

static const uint8_t DIFUSION[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
static QueueHandle_t cola;
static volatile int ultimo_rssi;

/*
 * Llega en el contexto de la tarea de WiFi: acá no se procesa nada, solo se copia la trama
 * a la cola. Parsear JSON o tocar hardware en este callback frena la radio.
 */
static void al_recibir(const esp_now_recv_info_t *info, const uint8_t *datos, int largo)
{
    if (info == NULL || datos == NULL || largo <= 0) return;

    enlace_trama_t trama;
    size_t n = (size_t)largo > ENLACE_MAX_DATOS ? ENLACE_MAX_DATOS : (size_t)largo;
    memcpy(trama.mac, info->src_addr, sizeof(trama.mac));
    trama.rssi = info->rx_ctrl != NULL ? info->rx_ctrl->rssi : 0;
    trama.largo = n;
    memcpy(trama.datos, datos, n);
    trama.datos[n] = '\0';
    ultimo_rssi = trama.rssi;

    if (xQueueSend(cola, &trama, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Cola llena: se descarta una trama");
    }
}

esp_err_t enlace_iniciar(uint8_t canal)
{
    if (cola != NULL) return ESP_ERR_INVALID_STATE;

    /* El WiFi guarda la calibración del PHY en la NVS */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "borrar NVS");
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "iniciar NVS");

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif");
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;   /* ya creado: está bien */

    wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&wcfg), TAG, "esp_wifi_init");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "storage");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "modo STA");
    /* Argentina: canales 1 a 13 (sin esto, un canal 12 o 13 puede dar problemas) */
    ESP_RETURN_ON_ERROR(esp_wifi_set_country_code("AR", false), TAG, "país");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start");
    ESP_RETURN_ON_ERROR(esp_wifi_set_channel(canal, WIFI_SECOND_CHAN_NONE), TAG, "canal %u", canal);

    cola = xQueueCreate(LARGO_COLA, sizeof(enlace_trama_t));
    if (cola == NULL) return ESP_ERR_NO_MEM;

    ESP_RETURN_ON_ERROR(esp_now_init(), TAG, "esp_now_init");
    ESP_RETURN_ON_ERROR(esp_now_register_recv_cb(al_recibir), TAG, "callback de recepción");

    /* Aun para difundir hay que dar de alta el destino */
    esp_now_peer_info_t destino = { 0 };
    memcpy(destino.peer_addr, DIFUSION, sizeof(DIFUSION));
    destino.channel = canal;
    destino.ifidx = WIFI_IF_STA;
    destino.encrypt = false;
    ESP_RETURN_ON_ERROR(esp_now_add_peer(&destino), TAG, "destino de difusión");

    uint8_t mac[6];
    enlace_mac(mac);
    ESP_LOGI(TAG, "ESP-NOW listo en el canal %u. MAC " MACSTR, canal, MAC2STR(mac));
    return ESP_OK;
}

esp_err_t enlace_enviar(const void *datos, size_t largo)
{
    if (largo == 0 || largo > ENLACE_MAX_DATOS) return ESP_ERR_INVALID_SIZE;
    return esp_now_send(DIFUSION, (const uint8_t *)datos, largo);
}

esp_err_t enlace_enviar_texto(const char *texto)
{
    return enlace_enviar(texto, strlen(texto));
}

bool enlace_recibir(enlace_trama_t *trama, TickType_t espera)
{
    return cola != NULL && xQueueReceive(cola, trama, espera) == pdTRUE;
}

int enlace_ultimo_rssi(void)
{
    return ultimo_rssi;
}

void enlace_mac(uint8_t mac[6])
{
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
}
