/*
 * ============================================================================================
 *  HOJA DE LA MESH DE AURA — gabinete de lockers (ESP-IDF 6.1)
 *  Lockers UNRaf · Ingeniería en Computación
 * ============================================================================================
 *
 *  El gabinete deja de hablar con el backend por HTTP o ESP-NOW: es una HOJA de la malla
 *  ESP-WIFI-MESH de AURA, programada sobre la biblioteca nodo_mesh de la cátedra
 *  (aura-firmware/Mesh_Red_Completa/componentes/nodo_mesh). La biblioteca resuelve la unión a
 *  la malla, el aula, la cola con confirmación de AURA, los reintentos y la hora. Lo propio
 *  del gabinete es solo esto:
 *
 *   QUÉ MIDE   el microswitch de cada puerta y si su solenoide está energizado. Sale una
 *              medición en cada cambio y una completa cada "intervalo_s":
 *                {"puerta_1":0,"puerta_2":1,"puerta_3":0,"puerta_4":0,
 *                 "solenoide_1":0,"solenoide_2":1,"solenoide_3":0,"solenoide_4":0}
 *              puerta_N    1 = abierta (switch libre), 0 = cerrada
 *              solenoide_N 1 = energizado (la puerta se puede abrir), 0 = trabada
 *
 *   QUÉ ACEPTA el comando "abrir" (de AURA, por hw/<hw_id>/command):
 *                {"command":"abrir","params":{"puerta":1,"ms":15000},"command_id":"lk-12"}
 *              Energiza el solenoide de esa puerta "ms" milisegundos (15 000 por
 *              especificación; 100 a 20 000) y contesta "aplicado" apenas arranca el pulso.
 *              Una orden para una puerta ya energizada extiende el pulso (un reintento del
 *              backend no es un error). Una orden "local" (el botón del concentrador del aula)
 *              NUNCA abre una puerta.
 *
 *   PARÁMETROS (set_config, todo o nada, guardados en NVS):
 *              intervalo_s    5 a 3600 (30)   medición completa periódica; la raíz marca la
 *                                             hoja offline a los 3 intervalos sin datos
 *              max_abierta_s  30 a 3600 (120) puerta abierta más que esto -> alerta
 *
 *   ALERTAS    hw/<hw_id>/alerts/puerta, una por cambio:
 *              apertura_sin_orden  (high)    se abrió sin que su solenoide estuviera energizado
 *              abierta_demasiado   (warning) lleva más de max_abierta_s abierta
 *              cerrada             (info)    se cerró una puerta que tenía una alerta
 *
 *  Las reglas del préstamo (código, 15 s para abrir, alerta a los 45 s, mora...) NO viven acá:
 *  siguen en el backend de lockers, que recibe estas mediciones por el puente MQTT
 *  (gateway/puente_mesh.py). La hoja solo acciona, mide y se protege.
 *
 *  Todas las placas del mismo tipo llevan ESTE MISMO binario: no hay MAC, código de nodo ni
 *  aula en el código. La identidad es la MAC (hw_id = mac-...), y el aula la asigna AURA con
 *  set_config {"aula": "..."}. MESH_ID y MESH_AP_PASS van en main/config_local.h.
 *
 *  PLACAS (se elige con el target de ESP-IDF):
 *   esp32c3  ESP32-C3 SuperMini: un GPIO por solenoide (gate del IRLZ44N). Es la placa de las
 *            hojas de AURA y la del gabinete WiFi (nodo_wifi), con los mismos pines.
 *   esp32s3  Seeed XIAO ESP32S3: solenoides por el SN74HC595, como el nodo ESP-NOW.
 * ============================================================================================
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/gpio.h"
#include "cJSON.h"
#include "nodo_mesh.h"
#include "puertas.h"

#if __has_include("config_local.h")
#include "config_local.h"
#else
#error "Falta main/config_local.h: copiá config_local.ejemplo.h como config_local.h y completá el ID y la clave de la mesh (los da la cátedra)"
#endif

/* ============================== Placa ============================== */
/* values tiene que entrar en 160 bytes de JSON: con 4 puertas son ~120. Para más puertas en
   una misma placa hay que achicar los nombres o sacar los solenoide_N. */
#define CANT_PUERTAS 4

#if CONFIG_IDF_TARGET_ESP32C3
#define PLACA "c3_supermini"
/* Mismos pines que nodo_wifi. GPIO2, 8 y 9 son de arranque: no se usan para la potencia. */
static const gpio_num_t PIN_SOLENOIDE[CANT_PUERTAS]   = { GPIO_NUM_0, GPIO_NUM_1, GPIO_NUM_3, GPIO_NUM_4 };
static const gpio_num_t PIN_MICROSWITCH[CANT_PUERTAS] = { GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_10 };
#define PIN_LED          GPIO_NUM_8          /* LED azul de la SuperMini */
#define LED_ACTIVO_BAJO  1

#elif CONFIG_IDF_TARGET_ESP32S3
#define PLACA "xiao_s3_595"
/* Mismos pines que el nodo ESP-NOW (firmware/nodo) */
#define PIN_SR_DATOS     GPIO_NUM_2          /* D1 -> SER   (pin 14 del 74HC595) */
#define PIN_SR_RELOJ     GPIO_NUM_3          /* D2 -> SRCLK (pin 11) */
#define PIN_SR_LATCH     GPIO_NUM_4          /* D3 -> RCLK  (pin 12) */
static const gpio_num_t PIN_MICROSWITCH[CANT_PUERTAS] = { GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_43, GPIO_NUM_44 };
#define PIN_LED          GPIO_NUM_21         /* LED de usuario de la XIAO */
#define LED_ACTIVO_BAJO  1

#else
#error "Placa no prevista: el target tiene que ser esp32c3 (SuperMini) o esp32s3 (XIAO)"
#endif

/* Potencia en pasos de 0,25 dBm. La C3 SuperMini tiene la antena mal adaptada: la cátedra
   usa 60 (15 dBm) con un alambre de 31 mm. Con antena NO subir a 19,5 dBm (guía, sección 6),
   y menos acá, que la fuente también alimenta los solenoides. */
#define POTENCIA_TX         60

/* Solenoide: lo decide el backend en cada orden, con estos límites para proteger la bobina */
#define PULSO_DEFECTO_MS    15000
#define PULSO_MIN_MS        100
#define PULSO_MAX_MS        20000
/* Si da recalentamiento en las pruebas: true corta apenas el switch confirma la apertura */
#define CORTAR_AL_ABRIR     false
/* Una puerta que se abre hasta este tiempo después de que terminó su pulso no es forzada
   (la traba tarda en volver y la persona puede estar tirando justo en el último segundo) */
#define GRACIA_APERTURA_MS  3000

#define INTERVALO_DEFECTO_S 30
#define INTERVALO_MIN_S     5
#define INTERVALO_MAX_S     3600
#define MAX_ABIERTA_DEF_S   120
#define MAX_ABIERTA_MIN_S   30
#define MAX_ABIERTA_MAX_S   3600

#define PERIODO_REVISION_MS 20               /* cada cuánto se miran switches y solenoides */
#define NVS_ESPACIO         "lockers"

static const char *TAG = "LOCKERS";

static volatile uint32_t intervalo_s = INTERVALO_DEFECTO_S;
static volatile uint32_t max_abierta_s = MAX_ABIERTA_DEF_S;
static volatile bool medir_ya = false;

/* ============================== Configuración ============================== */
static bool leer_entero(const cJSON *params, const char *nombre, uint32_t min, uint32_t max,
                        bool *presente, uint32_t *valor)
{
    const cJSON *p = cJSON_GetObjectItemCaseSensitive(params, nombre);
    *presente = p != NULL;
    if (p == NULL) {
        return true;
    }
    if (!cJSON_IsNumber(p) || p->valuedouble < min || p->valuedouble > max ||
        p->valuedouble != (double)(uint32_t)p->valuedouble) {
        return false;
    }
    *valor = (uint32_t)p->valuedouble;
    return true;
}

static void nvs_guardar_u32(const char *clave, uint32_t valor)
{
    nvs_handle_t h;
    if (nvs_open(NVS_ESPACIO, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u32(h, clave, valor);
        nvs_commit(h);
        nvs_close(h);
    }
}

static void nvs_cargar(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_ESPACIO, NVS_READONLY, &h) != ESP_OK) {
        return;                                          /* primera vez: valores por defecto */
    }
    uint32_t v;
    if (nvs_get_u32(h, "intervalo_s", &v) == ESP_OK && v >= INTERVALO_MIN_S && v <= INTERVALO_MAX_S) {
        intervalo_s = v;
    }
    if (nvs_get_u32(h, "max_abierta_s", &v) == ESP_OK && v >= MAX_ABIERTA_MIN_S && v <= MAX_ABIERTA_MAX_S) {
        max_abierta_s = v;
    }
    nvs_close(h);
}

/* set_config: primero se valida TODO y recién después se aplica (contrato §3.3).
   "aula" la maneja nodo_mesh: acá solo se la deja pasar. */
static bool aplicar_config(const cJSON *params, char *motivo, size_t tam)
{
    const cJSON *p;
    cJSON_ArrayForEach(p, params) {
        if (strcmp(p->string, "intervalo_s") != 0 && strcmp(p->string, "max_abierta_s") != 0 &&
            strcmp(p->string, "aula") != 0) {
            snprintf(motivo, tam, "parametro_desconocido");
            return false;
        }
    }
    bool hay_intervalo, hay_max;
    uint32_t nuevo_intervalo = 0, nuevo_max = 0;
    if (!leer_entero(params, "intervalo_s", INTERVALO_MIN_S, INTERVALO_MAX_S, &hay_intervalo, &nuevo_intervalo)) {
        snprintf(motivo, tam, "intervalo_s_fuera_de_rango");
        return false;
    }
    if (!leer_entero(params, "max_abierta_s", MAX_ABIERTA_MIN_S, MAX_ABIERTA_MAX_S, &hay_max, &nuevo_max)) {
        snprintf(motivo, tam, "max_abierta_s_fuera_de_rango");
        return false;
    }

    /* Todo validó: se aplica y se guarda */
    if (hay_intervalo) {
        intervalo_s = nuevo_intervalo;
        nvs_guardar_u32("intervalo_s", nuevo_intervalo);
    }
    if (hay_max) {
        max_abierta_s = nuevo_max;
        nvs_guardar_u32("max_abierta_s", nuevo_max);
    }
    ESP_LOGI(TAG, "Config: intervalo %" PRIu32 " s, alerta de puerta abierta a los %" PRIu32 " s",
             intervalo_s, max_abierta_s);
    medir_ya = true;
    return true;
}

static void describir_config(cJSON *config)
{
    cJSON_AddNumberToObject(config, "intervalo_s", intervalo_s);
    cJSON_AddNumberToObject(config, "max_abierta_s", max_abierta_s);
    cJSON_AddNumberToObject(config, "puertas", CANT_PUERTAS);
}

/* ============================== Comandos ============================== */
/* Corre en la tarea de nodo_mesh: no puede bloquearse. puertas_abrir() solo encola la orden
   y la tarea de puertas arranca el pulso en milisegundos. */
static bool ejecutar_comando(const char *comando, const cJSON *params, bool local, char *motivo, size_t tam)
{
    if (strcmp(comando, "abrir") != 0) {
        snprintf(motivo, tam, "comando_desconocido");
        return false;
    }
    if (local) {
        /* El botón del concentrador es para el aula: una puerta solo se abre por una orden
           del backend de lockers, que validó el código de la persona */
        ESP_LOGW(TAG, "Orden local de apertura ignorada");
        snprintf(motivo, tam, "orden_local_no_permitida");
        return false;
    }
    const cJSON *pu = cJSON_GetObjectItemCaseSensitive(params, "puerta");
    if (!cJSON_IsNumber(pu) || pu->valuedouble < 1 || pu->valuedouble > CANT_PUERTAS ||
        pu->valuedouble != (double)(int)pu->valuedouble) {
        snprintf(motivo, tam, "puerta_fuera_de_rango");
        return false;
    }
    uint32_t ms = PULSO_DEFECTO_MS;
    const cJSON *m = cJSON_GetObjectItemCaseSensitive(params, "ms");
    if (m != NULL) {
        if (!cJSON_IsNumber(m) || m->valuedouble < PULSO_MIN_MS || m->valuedouble > PULSO_MAX_MS) {
            snprintf(motivo, tam, "ms_fuera_de_rango");
            return false;
        }
        ms = (uint32_t)m->valuedouble;
    }
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(params, "id");   /* id del backend, solo para el log */
    uint32_t id_orden = cJSON_IsNumber(id) ? (uint32_t)id->valuedouble : 0;

    uint8_t puerta = (uint8_t)pu->valuedouble - 1;
    esp_err_t err = puertas_abrir(puerta, id_orden, ms);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "No pude encolar la apertura de la puerta %u: %s", puerta + 1, esp_err_to_name(err));
        snprintf(motivo, tam, "puertas_ocupadas");
        return false;
    }
    ESP_LOGI(TAG, "ABRIR puerta %u durante %" PRIu32 " ms (orden %" PRIu32 ")", puerta + 1, ms, id_orden);
    return true;
}

/* ============================== Mediciones y alertas ============================== */
static void medir(const bool *abierta, const bool *energizada)
{
    cJSON *v = cJSON_CreateObject();
    char campo[16];
    for (int i = 0; i < CANT_PUERTAS; i++) {
        snprintf(campo, sizeof(campo), "puerta_%d", i + 1);
        cJSON_AddNumberToObject(v, campo, abierta[i] ? 1 : 0);
    }
    for (int i = 0; i < CANT_PUERTAS; i++) {
        snprintf(campo, sizeof(campo), "solenoide_%d", i + 1);
        cJSON_AddNumberToObject(v, campo, energizada[i] ? 1 : 0);
    }
    if (!nodo_mesh_medicion(v)) {
        ESP_LOGW(TAG, "La medición no entró en la cola");
    }
    cJSON_Delete(v);
}

static void alerta_puerta(int puerta, const char *severity, const char *motivo, const char *mensaje,
                          uint32_t segundos)
{
    cJSON *d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "puerta", puerta + 1);
    cJSON_AddStringToObject(d, "motivo", motivo);
    if (segundos) {
        cJSON_AddNumberToObject(d, "segundos", segundos);
    }
    char texto[48];
    snprintf(texto, sizeof(texto), "Puerta %d %s", puerta + 1, mensaje);
    nodo_mesh_alerta("puerta", severity, texto, d);
    cJSON_Delete(d);
    ESP_LOGW(TAG, "Alerta: %s (%s)", texto, motivo);
}

/*
 * Mira switches y solenoides cada 20 ms. En cada cambio manda una medición en el acto (el
 * backend necesita el ABIERTO enseguida), y cada intervalo_s una completa aunque no cambie
 * nada: resincroniza al backend si se perdió algo y mantiene a la hoja "online" en AURA.
 */
static void tarea_gabinete(void *arg)
{
    bool abierta[CANT_PUERTAS], energizada[CANT_PUERTAS];
    bool alerta_forzada[CANT_PUERTAS] = {0}, alerta_demora[CANT_PUERTAS] = {0};
    int64_t abierta_desde[CANT_PUERTAS], fin_pulso[CANT_PUERTAS];

    int64_t ahora = esp_timer_get_time();
    for (int i = 0; i < CANT_PUERTAS; i++) {
        abierta[i] = puertas_abierta(i);       /* estado de arranque: sin alertas por lo de antes */
        energizada[i] = puertas_energizada(i);
        abierta_desde[i] = ahora;
        fin_pulso[i] = INT64_MIN / 2;
    }
    medir(abierta, energizada);
    int64_t ultima = ahora;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(PERIODO_REVISION_MS));
        ahora = esp_timer_get_time();
        bool cambio = false;

        for (int i = 0; i < CANT_PUERTAS; i++) {
            bool e = puertas_energizada(i);
            if (e != energizada[i]) {
                if (!e) {
                    fin_pulso[i] = ahora;
                }
                energizada[i] = e;
                cambio = true;
            }

            bool a = puertas_abierta(i);
            if (a != abierta[i]) {
                abierta[i] = a;
                cambio = true;
                if (a) {
                    abierta_desde[i] = ahora;
                    bool con_orden = e || (ahora - fin_pulso[i]) < (int64_t)GRACIA_APERTURA_MS * 1000;
                    if (!con_orden) {
                        alerta_forzada[i] = true;
                        alerta_puerta(i, "high", "apertura_sin_orden", "abierta sin orden", 0);
                    }
                } else if (alerta_forzada[i] || alerta_demora[i]) {
                    alerta_forzada[i] = alerta_demora[i] = false;
                    alerta_puerta(i, "info", "cerrada", "cerrada", 0);
                }
            }

            if (abierta[i] && !alerta_demora[i] &&
                (ahora - abierta_desde[i]) > (int64_t)max_abierta_s * 1000000) {
                alerta_demora[i] = true;
                alerta_puerta(i, "warning", "abierta_demasiado", "abierta demasiado",
                              (uint32_t)((ahora - abierta_desde[i]) / 1000000));
            }
        }

        if (cambio || medir_ya || (ahora - ultima) >= (int64_t)intervalo_s * 1000000) {
            medir_ya = false;
            ultima = ahora;
            medir(abierta, energizada);
        }
    }
}

/* ============================== LED de estado ============================== */
/* fijo = en la malla con aula · 1 Hz = en la malla sin aula (AURA todavía no la asignó)
   · 4 Hz = buscando la malla */
static void led(bool encendido)
{
    gpio_set_level(PIN_LED, LED_ACTIVO_BAJO ? !encendido : encendido);
}

static void tarea_led(void *arg)
{
    uint32_t n = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(125));
        n++;
        if (!nodo_mesh_conectada()) {
            led(n % 2);
        } else if (nodo_mesh_aula()[0] == '\0') {
            led((n / 4) % 2);
        } else {
            led(true);
        }
    }
}

/* ============================== Arranque ============================== */
void app_main(void)
{
    /* 1. Primero la potencia: todas las salidas a cero antes que cualquier otra cosa */
    puertas_config_t pcfg = PUERTAS_CONFIG_DEFECTO();
    pcfg.cantidad = CANT_PUERTAS;
#if CONFIG_IDF_TARGET_ESP32C3
    pcfg.tipo_salida = PUERTAS_SALIDA_GPIO;
    for (int i = 0; i < CANT_PUERTAS; i++) {
        pcfg.solenoide[i] = PIN_SOLENOIDE[i];
    }
#else
    pcfg.tipo_salida = PUERTAS_SALIDA_595;
    pcfg.registro.datos = PIN_SR_DATOS;
    pcfg.registro.reloj = PIN_SR_RELOJ;
    pcfg.registro.latch = PIN_SR_LATCH;
#endif
    for (int i = 0; i < CANT_PUERTAS; i++) {
        pcfg.microswitch[i] = PIN_MICROSWITCH[i];
    }
    pcfg.ms_pulso_min = PULSO_MIN_MS;
    pcfg.ms_pulso_max = PULSO_MAX_MS;
    pcfg.cortar_al_abrir = CORTAR_AL_ABRIR;
    ESP_ERROR_CHECK(puertas_iniciar(&pcfg));

    gpio_reset_pin(PIN_LED);
    gpio_set_direction(PIN_LED, GPIO_MODE_OUTPUT);
    led(false);

    /* 2. NVS (la usan nodo_mesh y nuestra configuración) */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    nvs_cargar();

    ESP_LOGI(TAG, "Gabinete de lockers (%s), %d puertas, intervalo %" PRIu32 " s",
             PLACA, CANT_PUERTAS, intervalo_s);

    /* 3. La malla */
    nodo_mesh_config_t cfg = {
        .mesh_id = {MESH_ID_BYTES},
        .mesh_clave = MESH_AP_PASS,
        .potencia_tx = POTENCIA_TX,
        .alimentacion = "red",
        .aplicar_config = aplicar_config,
        .describir_config = describir_config,
        .ejecutar_comando = ejecutar_comando,
    };
    ESP_ERROR_CHECK(nodo_mesh_iniciar(&cfg));

    xTaskCreate(tarea_gabinete, "gabinete", 4096, NULL, 4, NULL);
    xTaskCreate(tarea_led, "led", 2048, NULL, 2, NULL);
}
