# Radio ESP-NOW por difusión: la usan el nodo, el gateway y la prueba de enlace.
idf_component_register(SRCS "enlace_espnow.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_wifi
                       PRIV_REQUIRES esp_netif esp_event nvs_flash esp_hw_support)
