/**
 * A strict JSON-Schema validator for the subset the DSH tool registry accepts,
 * written independently of `dsh-plugin-devkit` (this plugin must be testable
 * without the devkit installed).
 *
 * ## Why not a JSON-Schema library
 *
 * The registry does not implement JSON Schema; it implements a *compiled subset*
 * (`dsh-plugin-development.md` §12). A validator that accepts the full standard
 * would pass a schema the registry rejects at load time — `oneOf` inside
 * `items`, `type: ['string','number']`, `additionalProperties` omitted, and so
 * on. The whole point of this file is to be *stricter than* a general validator,
 * so a plugin author learns about a divergence here rather than from
 * `tool returned invalid output` on a live call.
 *
 * ## Allowed node keywords
 *
 * `type` (one string), `oneOf`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const`, `description`, `title`, `default`, `examples`.
 *
 * Anything else is an error: the registry ignores unknown keywords, which means
 * an author who writes `minimum: 1` believes it is enforced when it is not.
 */

/** Keywords a schema node may carry. */
export const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/** Primitive JSON types accepted in a `type` keyword. */
export const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Describe a schema position for an error message. */
function at(path) {
  return path;
}

/**
 * Validate one schema node recursively.
 *
 * @param {unknown} node - the schema node.
 * @param {string} [path] - JSON-pointer-ish path for error messages.
 * @returns {string[]} every problem found; empty when the node is acceptable.
 */
export function validateSchemaNode(node, path = '$') {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(node)) {
    return [`${at(path)}: a schema node must be a plain object`];
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) errors.push(`${at(path)}: unsupported keyword "${key}" (allowed: ${[...ALLOWED_KEYWORDS].join(', ')})`);
  }

  if ('type' in node) {
    if (typeof node.type !== 'string') {
      errors.push(`${at(path)}: "type" must be a single string, not ${Array.isArray(node.type) ? 'an array' : typeof node.type}`);
    } else if (!ALLOWED_TYPES.has(node.type)) {
      errors.push(`${at(path)}: unsupported type "${node.type}" (allowed: ${[...ALLOWED_TYPES].join(', ')})`);
    }
  } else if (!('oneOf' in node) && !('const' in node) && !('enum' in node)) {
    errors.push(`${at(path)}: a node needs "type" (or one of oneOf/const/enum)`);
  }

  if ('oneOf' in node) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
      errors.push(`${at(path)}: "oneOf" must be a non-empty array`);
    } else {
      node.oneOf.forEach((child, index) => errors.push(...validateSchemaNode(child, `${path}.oneOf[${index}]`)));
    }
  }

  if ('properties' in node) {
    if (!isPlainObject(node.properties)) {
      errors.push(`${at(path)}: "properties" must be an object`);
    } else {
      for (const [name, child] of Object.entries(node.properties)) {
        errors.push(...validateSchemaNode(child, `${path}.properties.${name}`));
      }
    }
  }

  if ('required' in node) {
    if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== 'string')) {
      errors.push(`${at(path)}: "required" must be an array of strings`);
    } else if (isPlainObject(node.properties)) {
      for (const name of node.required) {
        if (!(name in node.properties)) errors.push(`${at(path)}: required field "${name}" is not declared in "properties"`);
      }
    } else {
      errors.push(`${at(path)}: "required" without "properties" is not supported`);
    }
  }

  if ('additionalProperties' in node) {
    if (node.additionalProperties !== false) {
      errors.push(`${at(path)}: "additionalProperties" must be exactly false, got ${JSON.stringify(node.additionalProperties)}`);
    }
  } else if (isPlainObject(node.properties)) {
    errors.push(`${at(path)}: an object node with "properties" must declare "additionalProperties": false`);
  }

  if ('items' in node) {
    if (!isPlainObject(node.items)) errors.push(`${at(path)}: "items" must be a single schema object (tuples are not supported)`);
    else errors.push(...validateSchemaNode(node.items, `${path}.items`));
  }

  if ('enum' in node) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      errors.push(`${at(path)}: "enum" must be a non-empty array`);
    } else if (typeof node.type === 'string') {
      for (const value of node.enum) {
        const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
        const expected = node.type === 'integer' ? 'number' : node.type;
        if (actual !== expected) errors.push(`${at(path)}: enum value ${JSON.stringify(value)} is not of type "${node.type}"`);
      }
    }
  }

  if ('examples' in node && !Array.isArray(node.examples)) errors.push(`${at(path)}: "examples" must be an array`);
  if ('title' in node && typeof node.title !== 'string') errors.push(`${at(path)}: "title" must be a string`);
  if ('description' in node && typeof node.description !== 'string') errors.push(`${at(path)}: "description" must be a string`);

  return errors;
}

/** Render a JS value as a JSON type name. */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Validate a *value* against a schema node (the returned-value half of the
 * contract). This is what the registry does to an `execute` result; here it is
 * used to prove the tools' return shapes satisfy their own declared schemas.
 *
 * @param {unknown} value - the value to check.
 * @param {Record<string, any>} schema - a schema node previously accepted by {@link validateSchemaNode}.
 * @param {string} [path] - path for error messages.
 * @returns {string[]} violations; empty when the value conforms.
 */
export function validateValue(value, schema, path = '$') {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(schema)) return [`${path}: schema is not an object`];

  if ('oneOf' in schema) {
    const matches = schema.oneOf.filter((child) => validateValue(value, child, path).length === 0);
    if (matches.length !== 1) errors.push(`${path}: value matches ${matches.length} oneOf branches, expected exactly 1`);
    return errors;
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if ('enum' in schema && Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the enum values ${JSON.stringify(schema.enum)}`);
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === undefined) return errors;

  const actual = jsonTypeOf(value);
  const typeMatches =
    type === 'number'
      ? actual === 'number' || actual === 'integer'
      : type === 'integer'
        ? actual === 'integer'
        : actual === type;
  if (!typeMatches) {
    errors.push(`${path}: expected type "${type}", got "${actual}" (${JSON.stringify(value)})`);
    return errors;
  }

  if (type === 'object') {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (!(name in value)) errors.push(`${path}: missing required field "${name}"`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in properties)) errors.push(`${path}: undeclared field "${name}"`);
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (value[name] !== undefined) errors.push(...validateValue(value[name], child, `${path}.${name}`));
    }
  } else if (type === 'array') {
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => errors.push(...validateValue(item, schema.items, `${path}[${index}]`)));
    }
  }

  return errors;
}
