// js-base — motor de reglas de autorización (CommonJS, cero dependencias de runtime).
//
// Construye el objeto `rules` que el nucleo (server) inyecta via createApp({ rules }).
// Los handlers invocan `rules.check(ctx)` antes de ejecutar la operación. Este módulo
// NO hace HTTP ni I/O: solo lee la config del CollectionRegistry y evalúa el filtro
// de la operación con el `matchFilter` del vendor.
//
// Contract: knowledge/contracts/rules-engine.md
//
// Semántica de config.rules[op] (fijada en el contrato):
//   rule === null          -> operación PÚBLICA  -> { allow: true }
//   rule === undefined     -> op ausente en rules -> DENY por defecto -> { allow: false }
//   rule === objeto-filtro -> matchFilter(evalCtx, rule) -> { allow: <bool> }
// donde evalCtx = { auth: ctx.auth ?? null, record: ctx.record ?? null, request: ctx.request }.
//
// Convención canónica para "exigir login": { "auth.id": { $exists: true } }.
// (matchFilter no tiene operador "existe un campo" con $ne:null útil: con auth=null,
// `auth.id` resuelve a `undefined`, y `undefined !== null` -> $ne:null da allow:true
// incluso sin auth. $exists:true sí discrimina: undefined -> deny, valor -> allow.)

const { matchFilter } = require("./vendor/js-store/vendor/js-doc-store.js");

/**
 * Construye el objeto `rules` para createApp({ rules }).
 *
 * @param {object} registry CollectionRegistry con método get(name) -> config | null.
 * @param {object} [_opts] Reservado (sin estado, sin I/O; hoy sin opciones).
 * @returns {{ check(ctx: object): Promise<{ allow: boolean }> }}
 */
function makeRules(registry, _opts) {
  if (!registry || typeof registry.get !== "function") {
    throw new Error("makeRules: se requiere un registry con get(name)");
  }

  return {
    /**
     * Decide si `ctx` está autorizado.
     * @param {object} ctx { op, collection, auth, record, request }
     * @returns {Promise<{ allow: boolean }>}
     */
    async check(ctx) {
      const config = registry.get(ctx.collection);
      // Colección desconocida: no se autoriza.
      if (!config) return { allow: false };

      const rule = config.rules ? config.rules[ctx.op] : undefined;

      // null -> pública. undefined (op ausente en rules) -> deny por defecto.
      if (rule === null) return { allow: true };
      if (rule === undefined) return { allow: false };

      // objeto-filtro: evaluar contra el ctx de evaluación.
      const evalCtx = {
        auth: ctx.auth ?? null,
        record: ctx.record ?? null,
        request: ctx.request,
      };
      return { allow: !!matchFilter(evalCtx, rule) };
    },
  };
}

module.exports = { makeRules };