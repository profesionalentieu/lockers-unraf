idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES enlace_espnow esp_driver_usb_serial_jtag vfs esp_hw_support)
