cmake_minimum_required(VERSION 3.16)
# Componentes compartidos de los lockers (puertas, enlace ESP-NOW)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../componentes")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Compila solo main y lo que main usa (no todo ESP-IDF): bastante más rápido
idf_build_set_property(MINIMAL_BUILD ON)
project(nodo)
