/*
 * Plantilla de config_local.h. Copiala como config_local.h (en esta misma carpeta)
 * y completá el ID y la clave de la mesh, que los da la cátedra.
 * config_local.h está en el .gitignore: NUNCA se sube al repositorio (es público).
 * Tienen que ser IGUALES a los del gateway y los concentradores de AURA.
 *
 * La hoja NO necesita el WiFi del edificio ni la dirección del backend: solo el
 * gateway (raíz) se conecta al router.
 */
#pragma once

#define MESH_ID_BYTES   0x00, 0x00, 0x00, 0x00, 0x00, 0x00     /* 6 bytes */
#define MESH_AP_PASS    "CAMBIAR"                               /* mínimo 8 caracteres */
