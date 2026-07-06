'use strict';

// src/router.js — Router HTTP minimalista por segmentos.
// Matching exacto por segmentos; soporta params ":name" pero NO regex,
// wildcards ni opcionalidad. Es el nucleo contra el que el server cablea rutas.

class Router {
  constructor() {
    // Lista de rutas registradas: { method, segments, handler }
    this.routes = [];
  }

  // add(method, pattern, handler) — registra una ruta.
  // pattern: "/api/collections/:col/records/:id" (segmentos literales o ":param").
  // method se normaliza a MAYUSCULAS.
  add(method, pattern, handler) {
    if (typeof method !== 'string' || method.length === 0) {
      throw new Error('Router.add: method (string) requerido');
    }
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('Router.add: pattern (string) requerido');
    }
    if (typeof handler !== 'function') {
      throw new Error('Router.add: handler (function) requerido');
    }
    const segments = splitSegments(pattern);
    if (segments.length === 0) {
      throw new Error('Router.add: pattern sin segmentos');
    }
    this.routes.push({ method: method.toUpperCase(), segments, handler });
  }

  // match(method, pathname) -> { handler, params } | null
  // Compara segmento a segmento; ":param" captura el valor en params.
  match(method, pathname) {
    const m = method.toUpperCase();
    const segs = splitSegments(pathname);
    for (const route of this.routes) {
      if (route.method !== m) continue;
      if (route.segments.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.segments[i];
        const s = segs[i];
        if (p.charCodeAt(0) === 0x3a /* ':' */) {
          params[p.slice(1)] = s;
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

// Parte un path/pattern en segmentos, descartando vacios (ignora "/" inicial
// y finales, y dobles slashes).
function splitSegments(s) {
  if (typeof s !== 'string') return [];
  return s.split('/').filter((seg) => seg.length > 0);
}

module.exports = { Router };