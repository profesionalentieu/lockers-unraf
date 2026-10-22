cmake_minimum_required(VERSION 3.16)

# ---------------------------------------------------------------------------------------------
#  Hoja de la mesh de AURA para el gabinete de lockers.
#
#  Usa dos grupos de componentes:
#   - los de la mesh de la cátedra (nodo_mesh y aura_mesh), que viven en el repo aura-firmware;
#   - "puertas" (pulso del solenoide y microswitches), que es nuestro.
#
#  El proyecto compila igual en los dos lugares donde puede estar:
#   1. en lockers-unraf/firmware/hoja_mesh, con aura-firmware como submódulo en
#      lockers-unraf/firmware/aura-firmware (git submodule update --init);
#   2. copiado a aura-firmware/dispositivos/<CÓDIGO>/ para el PR a la cátedra, con "puertas"
#      copiado adentro, en components/puertas (ver README.md de esta carpeta).
#  Con la variable de entorno AURA_FIRMWARE se puede apuntar a otra copia de aura-firmware.
# ---------------------------------------------------------------------------------------------
set(_candidatos_mesh
    "$ENV{AURA_FIRMWARE}/Mesh_Red_Completa/componentes"
    "${CMAKE_CURRENT_LIST_DIR}/../../Mesh_Red_Completa/componentes"
    "${CMAKE_CURRENT_LIST_DIR}/../aura-firmware/Mesh_Red_Completa/componentes")
set(_mesh "")
foreach(_dir IN LISTS _candidatos_mesh)
    if(_mesh STREQUAL "" AND EXISTS "${_dir}/nodo_mesh/include/nodo_mesh.h")
        set(_mesh "${_dir}")
    endif()
endforeach()
if(_mesh STREQUAL "")
    message(FATAL_ERROR
        "No encuentro los componentes de la mesh (nodo_mesh).\n"
        "Bajá el submódulo con:  git submodule update --init\n"
        "o definí AURA_FIRMWARE con la carpeta de tu copia de aura-firmware.")
endif()
message(STATUS "Componentes de la mesh: ${_mesh}")
set(EXTRA_COMPONENT_DIRS "${_mesh}")

# "puertas": dentro del proyecto (components/puertas) o el compartido de lockers-unraf
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/components/puertas")
    list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../componentes/puertas")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Compila solo main y lo que main usa (no todo ESP-IDF): bastante más rápido
idf_build_set_property(MINIMAL_BUILD ON)
project(hoja_lockers)
