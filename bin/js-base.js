#!/usr/bin/env node
'use strict';

// bin/js-base.js — launcher CLI de js-base.
// Lee PORT (default 3000), DATA_DIR (default ./data) y SECRET (OBLIGATORIO, sin
// default inseguro) del entorno, ensambla el server via createServer y escucha.
// Maneja SIGINT/SIGTERM -> close() y exit 0 limpio. Sin handles huérfanos.

const { createServer } = require('../src/app.js');

async function main() {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const DATA_DIR = process.env.DATA_DIR || './data';
  const SECRET = process.env.SECRET;

  if (!SECRET || typeof SECRET !== 'string' || SECRET.length < 16) {
    console.error('js-base: falta SECRET o es menor a 16 chars. Setea SECRET en el entorno.');
    process.exit(1);
  }

  const server = await createServer({ dataDir: DATA_DIR, secret: SECRET });

  await server.listen(PORT);
  console.log(`js-base escuchando en :${PORT}`);

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch (err) {
      console.error('js-base: error al cerrar:', err && err.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('js-base: error fatal al arrancar:', err && err.message);
  process.exit(1);
});