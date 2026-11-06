# Compila, FIRMA y graba la hoja de la mesh (guía de la cátedra, sección 2.9).
# Correr desde la terminal "ESP-IDF 6.1 PowerShell", parado en firmware\hoja_mesh:
#     .\grabar_firmado.ps1 -Puerto COM5
# La primera vez crea una clave de PRUEBA en C:\claves-aura (fuera del repo: nunca se sube).
# Con -Borrar hace además el erase-flash (borrado completo) antes de grabar.
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

idf.py build
if ($LASTEXITCODE -ne 0) { throw "La compilación falló" }

$bin = "build\aura-lockers.bin"
python -m espsecure sign-data --version 2 --keyfile $Clave --output build\firmado.bin $bin
if ($LASTEXITCODE -ne 0) { throw "No se pudo firmar" }
Move-Item -Force build\firmado.bin $bin
python -m espsecure verify-signature --version 2 --keyfile $Clave $bin
if ($LASTEXITCODE -ne 0) { throw "La firma no verifica" }

if ($Borrar) { idf.py -p $Puerto erase-flash }
idf.py -p $Puerto flash monitor
