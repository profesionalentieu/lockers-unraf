cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Compila solo main y lo que main usa (no todo ESP-IDF): bastante más rápido
idf_build_set_property(MINIMAL_BUILD ON)
project(obtener_mac)
