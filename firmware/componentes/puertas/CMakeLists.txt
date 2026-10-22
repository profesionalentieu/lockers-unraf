# Cerraduras (solenoides) y microswitches de un gabinete de lockers.
# La usan nodo_wifi (ESP32-C3, salida por GPIO) y nodo (XIAO ESP32S3, salida por 74HC595).
idf_component_register(SRCS "puertas.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_driver_gpio
                       PRIV_REQUIRES esp_timer esp_rom)
