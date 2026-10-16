#!/usr/bin/env bash
# ============================================================
#  Pañol UNRaf - arranque rapido (Mac / Linux)
#    chmod +x arrancar.sh   (una sola vez)
#    ./arrancar.sh
#  Ctrl+C detiene las dos cosas.
# ============================================================
set -e
RAIZ="$(cd "$(dirname "$0")" && pwd)"

echo
echo "  Pañol inteligente - UNRaf"
echo "  Levantando el sistema..."
echo

cd "$RAIZ/backend"
if [ ! -f data/lockers.db ]; then
  echo "  No hay base de datos todavia. Creandola..."
  npm run seed
fi

npm start &
PID_SERVIDOR=$!

sleep 4
cd "$RAIZ"
node gateway/simulador_nodo.js &
PID_SIMULADOR=$!

echo
echo "  Panel de Alumnado : http://localhost:3000/admin"
echo "  App de usuarios   : http://localhost:3000/"
echo "  Ctrl+C para apagar todo."
echo

# Al cortar con Ctrl+C, bajamos los dos procesos.
trap "kill $PID_SERVIDOR $PID_SIMULADOR 2>/dev/null" EXIT INT TERM
wait
