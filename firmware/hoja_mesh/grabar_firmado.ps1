# Compila, FIRMA y graba la hoja de la mesh (guia de la catedra, seccion 2.9).
# Correr desde la terminal "ESP-IDF 6.1 PowerShell", parado en firmware\hoja_mesh:
#     .\grabar_firmado.ps1 -Puerto COM5            (agrega -Borrar para el borrado completo)
# La primera vez crea una clave de PRUEBA en C:\claves-aura (fuera del repo: nunca se sube).
#
# - La imagen firmada se escribe APARTE (build\aura-lockers-firmado.bin): la de la compilacion
#   queda sin tocar, asi se puede correr las veces que haga falta.
# - Se graba con esptool, NO con "idf.py flash": idf.py flash puede recompilar y grabar una
#   imagen SIN firma, y la placa queda reiniciandose (check_signature_on_update_check).
param(
    [string]$Puerto = "COM5",
    [string]$Clave = "C:\claves-aura\firma_prueba.pem",
    [switch]$Borrar
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Clave)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Clave) | Out-Null
    Write-Host "Creando la clave de prueba $Clave (una sola vez)..."
    python -m espsecure generate-signing-key --version 2 --scheme rsa3072 $Clave
}

$bin = "build\aura-lockers.bin"
$firmado = "build\aura-lockers-firmado.bin"

# 1. Compilar. Si falta el .bin (lo borro una version anterior de este script), se borra la
#    marca que usa ESP-IDF para que lo vuelva a generar.
if (-not (Test-Path $bin)) { Remove-Item -Force "build\.bin_timestamp" -ErrorAction SilentlyContinue }
idf.py build
if ($LASTEXITCODE -ne 0) { throw "Fallo la compilacion" }

# 2. Firmar a un archivo aparte y verificar
Remove-Item -Force $firmado -ErrorAction SilentlyContinue
python -m espsecure sign-data --version 2 --keyfile $Clave --output $firmado $bin
if ($LASTEXITCODE -ne 0) { throw "No se pudo firmar" }
python -m espsecure verify-signature --version 2 --keyfile $Clave $firmado
if ($LASTEXITCODE -ne 0) { throw "La firma no verifica" }

# 3. Grabar con esptool la imagen firmada (sin recompilar)
Write-Host "Si dice 'Could not open $Puerto': cerra el monitor de la otra terminal o reconecta el USB."
if ($Borrar) {
    python -m esptool --chip esp32c3 -p $Puerto erase-flash
    if ($LASTEXITCODE -ne 0) { throw "No se pudo borrar: el puerto $Puerto esta ocupado?" }
}
python -m esptool --chip esp32c3 -p $Puerto -b 460800 --before default-reset --after hard-reset `
    write-flash --flash-mode dio --flash-freq 80m --flash-size keep `
    0x0 build\bootloader\bootloader.bin `
    0x8000 build\partition_table\partition-table.bin `
    0xf000 build\ota_data_initial.bin `
    0x20000 $firmado
if ($LASTEXITCODE -ne 0) { throw "No se pudo grabar: el puerto $Puerto esta ocupado?" }

# 4. Monitor (idf.py monitor no recompila ni graba)
idf.py -p $Puerto monitor
