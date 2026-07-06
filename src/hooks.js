'use strict';

// src/hooks.js — implementaciones DEFAULT reemplazables de rules y events.
// Son STUBS con contrato estable: otro batch los implementa de verdad.
// El nucleo (server) NO llama rules.check/events.emit automaticamente;
// son los handlers quienes los invocan, inyectados via createApp({ rules, events }).

// Shape del ctx que recibe rules.check (contrato de hooks, NO el ctx del handler):
//   { op: "list" | "view" | "create" | "update" | "delete",
//     collection: string,
//     auth: object | null,           // payload del token verificado, o null
//     record: object | null,          // doc sobre el que opera (view/update/delete), o null
//     request: { method, path, query } }
//
// Shape del evt que recibe events.emit:
//   { collection: string, op: "list"|"view"|"create"|"update"|"delete", record: object | null }

const defaultRules = {
  // check(ctx) -> { allow: boolean, ...? }
  // Default permisivo: otro batch implementa reglas reales (RBAC/filtros).
  async check(_ctx) {
    return { allow: true };
  },
};

const defaultEvents = {
  // emit(evt) — default no-op. Otro batch implementa side effects (auditoria/SSE).
  emit(_evt) {},
};

module.exports = { defaultRules, defaultEvents };