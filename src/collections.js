// js-base — registro de colecciones (CommonJS, cero dependencias de runtime).
//
// Persiste la configuración de las colecciones de js-base dentro de una colección
// de sistema "_collections" de un DocStore INYECTADO. El módulo NO crea su propio
// storage: recibe el DocStore por constructor. Así dos registros sobre el mismo
// DocStore ven la misma configuración (persistencia compartida).
//
// Contract: knowledge/contracts/collections.md
//
// La sección `rules` es OPACA: se acata su shape (objeto-filtro-o-null por acción)
// pero NO se evalúa — la evaluación de reglas es de otra fase.

const { DocStore, MemoryStorageAdapter } = require("./vendor/js-store/vendor/js-doc-store.js");

const SYSTEM_COLLECTION = "_collections";

const NAME_REGEX = /^[a-z][a-z0-9_]{0,49}$/;
const VALID_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
const RULE_KEYS = ["list", "view", "create", "update", "delete"];

/**
 * Devuelve un clon limpio de la config persistida (sin _id ni metadatos del store).
 */
function _toConfig(doc) {
  if (!doc) return null;
  return {
    name: doc.name,
    fields: doc.fields,
    rules: doc.rules,
    vector: doc.vector,
  };
}

/**
 * Valida una config de colección. Devuelve un array de errores (vacío si ok).
 * No lanza — quien llama decide lanzar o no.
 */
function _validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config debe ser un objeto"];
  }

  // name
  const name = config.name;
  if (typeof name !== "string" || !NAME_REGEX.test(name)) {
    errors.push(
      `name debe matchear ${NAME_REGEX} (no empezar con "_" y <=50 chars)`
    );
  }

  // fields
  const fields = config.fields;
  if (!Array.isArray(fields)) {
    errors.push("fields debe ser un array");
  } else {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        errors.push(`fields[${i}] debe ser un objeto`);
        continue;
      }
      if (typeof f.name !== "string" || f.name.length === 0) {
        errors.push(`fields[${i}].name debe ser un string no vacío`);
      }
      if (!VALID_TYPES.has(f.type)) {
        errors.push(
          `fields[${i}].type debe ser uno de ${Array.from(VALID_TYPES).join("|")} (se encontró ${String(f.type)})`
        );
      }
      if (f.required !== undefined && typeof f.required !== "boolean") {
        errors.push(`fields[${i}].required debe ser boolean si está presente`);
      }
    }
  }

  // rules — OPACO: solo shape, no evaluación.
  const rules = config.rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    errors.push("rules debe ser un objeto");
  } else {
    for (const key of RULE_KEYS) {
      if (key in rules) {
        const v = rules[key];
        if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
          errors.push(`rules.${key} debe ser un objeto-filtro o null`);
        }
      }
    }
  }

  // vector
  const vector = config.vector;
  if (vector !== null && vector !== undefined) {
    if (!vector || typeof vector !== "object" || Array.isArray(vector)) {
      errors.push("vector debe ser { dim: entero>0 } o null");
    } else if (
      typeof vector.dim !== "number" ||
      !Number.isInteger(vector.dim) ||
      vector.dim <= 0
    ) {
      errors.push("vector.dim debe ser un entero mayor a 0");
    }
  }

  return errors;
}

/**
 * Registro de colecciones de js-base. Persiste configs en la colección de sistema
 * "_collections" del DocStore inyectado.
 */
class CollectionRegistry {
  /**
   * @param {DocStore} db DocStore inyectado. El registro no crea storage propio.
   */
  constructor(db) {
    if (!db || typeof db.collection !== "function") {
      throw new Error("CollectionRegistry requiere un DocStore inyectado");
    }
    this.db = db;
    this._col = db.collection(SYSTEM_COLLECTION);
  }

  /**
   * Crea una nueva colección. Valida la config y lanza Error si es inválida o si
   * ya existe una colección con el mismo nombre. Devuelve la config persistida.
   */
  create(config) {
    const errors = _validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Config inválida: ${errors.join("; ")}`);
    }

    const existing = this._col.findById(config.name);
    if (existing) {
      throw new Error(`Ya existe una colección con nombre "${config.name}"`);
    }

    const doc = {
      _id: config.name,
      name: config.name,
      fields: config.fields,
      rules: config.rules,
      vector: config.vector ?? null,
    };
    this._col.insert(doc);
    return _toConfig(doc);
  }

  /**
   * Devuelve la config de la colección `name`, o null si no existe.
   */
  get(name) {
    const doc = this._col.findById(name);
    return _toConfig(doc);
  }

  /**
   * Lista todas las colecciones registradas como array de configs.
   */
  list() {
    return this._col.find({}).toArray().map(_toConfig);
  }

  /**
   * Actualiza parcialmente la colección `name`. Preserva lo no tocado (merge
   * superficial a nivel top-level: name, fields, rules, vector). Re-valida la
   * config resultante y lanza Error si queda inválida. Devuelve la nueva config.
   */
  update(name, partial) {
    const current = this._col.findById(name);
    if (!current) {
      throw new Error(`No existe la colección "${name}"`);
    }
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      throw new Error("update: partial debe ser un objeto");
    }

    // El nombre es inmutable vía update (es la PK); ignorar `partial.name`.
    const merged = {
      name: current.name,
      fields: partial.fields !== undefined ? partial.fields : current.fields,
      rules: partial.rules !== undefined ? partial.rules : current.rules,
      vector: partial.vector !== undefined ? partial.vector : current.vector,
    };

    const errors = _validateConfig(merged);
    if (errors.length > 0) {
      throw new Error(`Config inválida: ${errors.join("; ")}`);
    }

    // Reemplazo atómico: borrar + reinsertar con el mismo _id.
    this._col.removeById(name);
    const doc = {
      _id: merged.name,
      name: merged.name,
      fields: merged.fields,
      rules: merged.rules,
      vector: merged.vector ?? null,
    };
    this._col.insert(doc);
    return _toConfig(doc);
  }

  /**
   * Elimina la colección `name`. Devuelve true si existía y se borró, false si no.
   */
  remove(name) {
    const existing = this._col.findById(name);
    if (!existing) return false;
    this._col.removeById(name);
    return true;
  }

  /**
   * Valida un documento contra los fields de la colección `name` (tipo + required;
   * campos extra permitidos). Devuelve { ok, errors }.
   * Lanza Error si la colección `name` no existe.
   */
  validateDoc(name, doc) {
    const config = this.get(name);
    if (!config) {
      throw new Error(`No existe la colección "${name}"`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false, errors: ["doc debe ser un objeto"] };
    }

    const errors = [];
    for (const f of config.fields) {
      const value = doc[f.name];
      const isMissing = value === undefined;
      if (isMissing) {
        if (f.required) {
          errors.push(`Campo requerido faltante: ${f.name}`);
        }
        continue;
      }
      if (!_checkType(value, f.type)) {
        errors.push(
          `Tipo inválido para ${f.name}: esperado ${f.type}, se encontró ${_typeOf(value)}`
        );
      }
    }

    return { ok: errors.length === 0, errors };
  }
}

function _checkType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function _typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

module.exports = { CollectionRegistry, SYSTEM_COLLECTION, _validateConfig };