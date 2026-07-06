'use strict';

/**
 * Valida id: string no vacio. Devuelve un mensaje de violacion o null.
 * @param {any} id
 * @returns {string|null}
 */
function validateId(id) {
  if (typeof id !== 'string' || id === '') {
    return 'id: debe ser un string no vacio';
  }
  return null;
}

/**
 * Valida doc: objeto plano (no null, no array). Devuelve mensaje o null.
 * @param {any} doc
 * @returns {string|null}
 */
function validateDoc(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'doc: debe ser un objeto plano (no null, no array)';
  }
  return null;
}

/**
 * Valida vector: Array de longitud exacta dim con numeros finitos.
 * Devuelve mensaje o null. Ante input patologico devuelve null sin lanzar.
 * @param {any} vector
 * @param {number} dim
 * @returns {string|null}
 */
function validateVector(vector, dim) {
  const msg = 'vector: debe ser un Array de longitud ' + dim + ' con numeros finitos';
  if (!Array.isArray(vector) || vector.length !== dim) {
    return msg;
  }
  return allFinite(vector) ? null : msg;
}

/**
 * Devuelve true si todos los elementos son numeros finitos. Nunca lanza.
 * @param {any[]} arr
 * @returns {boolean}
 */
function allFinite(arr) {
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      return false;
    }
  }
  return true;
}

/**
 * Valida id, doc y vector de un item de entrada contra las reglas de dominio
 * de js-store. Devuelve un array de strings legibles con las violaciones
 * encontradas (vacio si todo es valido). Funcion pura: no muta argumentos, no
 * usa IO/red/subprocess y no lanza ante ningun input arbitrario.
 *
 * @param {any} id
 * @param {any} doc
 * @param {any} vector
 * @param {number} dim entero positivo asumido valido (no se valida a si mismo).
 * @returns {string[]}
 */
function validateInput(id, doc, vector, dim) {
  const violations = [];
  try {
    const checks = [
      validateId(id),
      validateDoc(doc),
      validateVector(vector, dim),
    ];
    for (let i = 0; i < checks.length; i++) {
      if (checks[i] !== null) {
        violations.push(checks[i]);
      }
    }
  } catch (_err) {
    // Ante cualquier input patologico, devolver lo acumulado sin lanzar.
  }
  return violations;
}

module.exports = { validateInput };