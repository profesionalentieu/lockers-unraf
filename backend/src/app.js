'use strict';
/** Configuracion de la aplicacion Express (sin levantar el servidor). */
const path = require('path');
const express = require('express');
const cors = require('cors');
const rutas = require('./routes');
const { noEncontrado, manejadorErrores } = require('./middleware/errorHandler');

const app = express();

app.use(cors());                       // el prototipo sirve los frontends del mismo origen
app.use(express.json({ limit: '64kb' }));

// Los tres frontends se sirven como estaticos desde el mismo backend:
//   http://<ip>:3000/              -> app de alumnos y docentes
//   http://<ip>:3000/locker/A-01   -> pantalla de la puerta (destino del QR)
//   http://<ip>:3000/admin         -> Mesa de Alumnado
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const PANTALLA_LOCKER = path.join(FRONTEND, 'locker', 'index.html');

app.use('/admin', express.static(path.join(FRONTEND, 'admin')));
app.get(['/locker', '/locker/:id'], (req, res) => res.sendFile(PANTALLA_LOCKER));
app.use('/', express.static(path.join(FRONTEND, 'usuario')));

app.use('/api', rutas);

app.use(noEncontrado);
app.use(manejadorErrores);

module.exports = app;
