idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES puertas esp_wifi esp_netif esp_event esp_http_client esp_timer nvs_flash)
