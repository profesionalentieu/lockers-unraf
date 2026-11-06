# Compila, FIRMA y graba la hoja de la mesh (guía de la cátedra, sección 2.9).
# Correr desde la terminal "ESP-IDF 6.1 PowerShell", parado en firmware\hoja_mesh:
#     .\grabar_firmado.ps1 -Puerto COM5            (agregá -Borrar para el borrado completo)
# La primera vez crea una clave de PRUEBA en C:\claves-aura (fuera del repo: nunca se sube).
#
# IMPORTANTE: graba con esptool, NO con "idf.py flash": idf.py flash puede volver a compilar
# y grabar un .bin nuevo SIN firma, y la placa queda reiniciándose (check_signature_on_update_check).
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

# 1. Compilar (se borra el .bin para que salga sin firma y no se firme dos veces)
$bin = "build\aura-lockers.bin"
Remove-Item -Force $bin -ErrorAction SilentlyContinue
idf.py build
if ($LASTEXITCODE -ne 0) { throw "La compilación falló" }

# 2. Firmar y verificar
python -m espsecure sign-data --version 2 --keyfile $Clave --output build\firmado.bin $bin
if ($LASTEXITCODE -ne 0) { throw "No se pudo firmar" }
Move-Item -Force build\firmado.bin $bin
python -m espsecure verify-signature --version 2 --keyfile $Clave $bin
if ($LASTEXITCODE -ne 0) { throw "La firma no verifica" }

# 3. Grabar con esptool (sin recompilar)
Write-Host "Si dice 'Could not open $Puerto': cerrá el monitor de la otra terminal o reconectá el USB."
if ($Borrar) {
    python -m esptool --chip esp32c3 -p $Puerto erase-flash
    if ($LASTEXITCODE -ne 0) { throw "No se pudo borrar: ¿el puerto $Puerto está ocupado?" }
}
python -m esptool --chip esp32c3 -p $Puerto -b 460800 --before default-reset --after hard-reset `
    write-flash --flash-mode dio --flash-freq 80m --flash-size keep `
    0x0 build\bootloader\bootloader.bin `
    0x8000 build\partition_table\partition-table.bin `
    0xf000 build\ota_data_initial.bin `
    0x20000 $bin
if ($LASTEXITCODE -ne 0) { throw "No se pudo grabar: ¿el puerto $Puerto está ocupado?" }

# 4. Monitor (idf.py monitor no recompila ni graba)
idf.py -p $Puerto monitor
