// A small JSON Schema (draft 2020-12) validator for the keywords the console's own schemas use:
// type, enum, const, properties, required, additionalProperties, items, minItems, maxItems,
// uniqueItems, minLength, maxLength, pattern, minimum, maximum, $ref (local "#/$defs/…"),
// anyOf, oneOf. An unknown keyword is an error, so a schema can't silently mean more than it checks.
// validate(schema, value) → [] when valid, else a list of "path: problem" strings.
const KNOWN = new Set(["$schema", "$id", "title", "description", "$defs", "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "$ref", "anyOf", "oneOf", "default"]);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t;
export function validate(schema, value, root = schema, path = "$", out = []) {
  if (schema === true) return out;
  if (schema === false) { out.push(`${path}: not allowed`); return out; }
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema keyword "${k}" isn't supported (at ${path})`);
  if (schema.$ref) {
    const m = /^#\/\$defs\/([\w-]+)$/.exec(schema.$ref); if (!m || !root.$defs?.[m[1]]) throw new Error(`unresolvable $ref ${schema.$ref}`);
    validate(root.$defs[m[1]], value, root, path, out);
  }
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.some((t) => isType(value, t))) { out.push(`${path}: should be ${ts.join(" or ")}, not ${typeOf(value)}`); return out; } }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: should be ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) out.push(`${path}: doesn't match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${path}: items repeat`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, out));
  }
  if (typeOf(value) === "object") {
    for (const r of schema.required || []) if (!(r in value)) out.push(`${path}: "${r}" is missing`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, root, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}: "${k}" isn't allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(schema.additionalProperties, v, root, `${path}.${k}`, out);
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => !validate(s, value, root, path, []).length)) out.push(`${path}: matches none of the allowed shapes`);
  if (schema.oneOf && schema.oneOf.filter((s) => !validate(s, value, root, path, []).length).length !== 1) out.push(`${path}: should match exactly one allowed shape`);
  return out;
}
