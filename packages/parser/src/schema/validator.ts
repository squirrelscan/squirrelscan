// Schema.org validation helpers

import type { ParsedSchema, SchemaValidationIssue } from "./types";

type PropertyType =
  | "string"
  | "url"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "stringOrArray"
  // schema.org range `ImageObject | URL` (image, logo): a URL string, an
  // ImageObject (inline or an `{"@id"}` reference), or an array of either.
  | "urlOrImage"
  | "objectOrArray"
  // Free text or structured steps, one or many: recipeInstructions takes a
  // string, a HowToStep / HowToSection, or an array of either.
  | "textOrObjects";

interface PropertyRule {
  type: PropertyType;
  /** Fields each object in the value must carry (any description of its `@id` counts). */
  required?: string[];
  /**
   * `required` for an object whose `@type` is listed, instead of the default.
   * An AggregateOffer carries `lowPrice` where an Offer carries `price`.
   */
  requiredByType?: Record<string, string[]>;
  /**
   * Fields the LAST entry of a list may leave out. Google's breadcrumb rules
   * exempt the final crumb, the current page, from `item`.
   */
  lastMayOmit?: string[];
  /** Other places a required field may be given, keyed by field. */
  alsoAt?: Record<string, (obj: Record<string, unknown>, nodes: NodeIndex) => boolean>;
}

interface SchemaRule {
  required?: string[];
  properties?: Record<string, PropertyRule>;
}

const TYPE_ALIASES: Record<string, string> = {
  BlogPosting: "Article",
  NewsArticle: "Article",
  TechArticle: "Article",
  ProductGroup: "Product",
  Corporation: "Organization",
};

const TYPE_RULES: Record<string, SchemaRule> = {
  Article: {
    required: ["headline", "image", "datePublished", "author"],
    properties: {
      headline: { type: "string" },
      image: { type: "urlOrImage" },
      datePublished: { type: "string" },
      author: { type: "objectOrArray", required: ["name"] },
      // Not required: Google's Article documentation lists no required
      // properties and does not recommend `publisher`, and a Person publisher
      // has no logo at all. When one is given it must still be named.
      publisher: { type: "objectOrArray", required: ["name"] },
    },
  },
  Product: {
    required: ["name", "image", "offers"],
    properties: {
      name: { type: "string" },
      image: { type: "urlOrImage" },
      offers: {
        type: "objectOrArray",
        required: ["price", "priceCurrency", "availability"],
        requiredByType: { AggregateOffer: ["lowPrice", "priceCurrency"] },
      },
    },
  },
  Organization: {
    required: ["name", "url"],
    properties: {
      name: { type: "string" },
      url: { type: "url" },
      logo: { type: "urlOrImage" },
    },
  },
  LocalBusiness: {
    required: ["name", "url", "address"],
    properties: {
      name: { type: "string" },
      url: { type: "url" },
      address: { type: "object" },
      image: { type: "urlOrImage" },
    },
  },
  WebSite: {
    required: ["name", "url"],
    properties: {
      name: { type: "string" },
      url: { type: "url" },
    },
  },
  WebPage: {
    required: ["name", "url"],
    properties: {
      name: { type: "string" },
      url: { type: "url" },
    },
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    properties: {
      // One ListItem or a list of them: in JSON-LD any property may hold a
      // single value.
      itemListElement: {
        type: "objectOrArray",
        required: ["position", "name", "item"],
        lastMayOmit: ["item"],
        // The older pattern names the crumb on its `item` node instead.
        alsoAt: {
          name: (crumb, nodes) =>
            describe(crumb.item, nodes).some((node) => !isMissing(node.name)),
        },
      },
    },
  },
  FAQPage: {
    required: ["mainEntity"],
    properties: {
      mainEntity: { type: "objectOrArray", required: ["name", "acceptedAnswer"] },
    },
  },
  VideoObject: {
    required: ["name", "description", "thumbnailUrl", "uploadDate"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      thumbnailUrl: { type: "stringOrArray" },
      uploadDate: { type: "string" },
    },
  },
  Event: {
    required: ["name", "startDate", "location"],
    properties: {
      name: { type: "string" },
      startDate: { type: "string" },
      location: { type: "object" },
    },
  },
  Recipe: {
    required: ["name", "image", "recipeIngredient", "recipeInstructions"],
    properties: {
      name: { type: "string" },
      image: { type: "urlOrImage" },
      recipeIngredient: { type: "stringOrArray" },
      recipeInstructions: { type: "textOrObjects" },
    },
  },
};

function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every description of an entity on the page, keyed by its `@id`: what a bare
 * `{"@id"}` reference points at. JSON-LD lets one entity be described in
 * several places, so all of them are kept.
 */
type NodeIndex = Map<string, Record<string, unknown>[]>;

/** A value and every other description of its `@id` on the page; none for a non-object. */
function describe(value: unknown, nodes: NodeIndex): Record<string, unknown>[] {
  if (!isPlainObject(value)) return [];
  const id = value["@id"];
  return typeof id === "string" ? [value, ...(nodes.get(id) ?? [])] : [value];
}

/**
 * Index every node inside the page's typed schemas that describes an entity
 * under an `@id`, at any depth. A node that is itself only a reference (`@id`,
 * optionally `@type`) describes nothing and is skipped. Iterative so a deeply
 * nested document cannot overflow the stack.
 */
function indexNodes(schemas: readonly Record<string, unknown>[]): NodeIndex {
  const index: NodeIndex = new Map();
  const stack: unknown[] = [...schemas];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (!isPlainObject(value)) continue;
    const id = value["@id"];
    if (typeof id === "string" && !isBareReference(value)) {
      const descriptions = index.get(id);
      if (descriptions) descriptions.push(value);
      else index.set(id, [value]);
    }
    for (const key in value) stack.push(value[key]);
  }
  return index;
}

/** schema.org `ImageObject` and its subtypes. */
const IMAGE_OBJECT_TYPES = new Set(["ImageObject", "Barcode", "ImageObjectSnapshot"]);

/** `ImageObject` from `ImageObject`, `schema:ImageObject` or `https://schema.org/ImageObject`. */
function bareTypeName(type: string): string {
  return type.replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/, "");
}

/**
 * A value in the range `ImageObject | URL`: a URL string, a reference to a node
 * (`{"@id"}`), or an image object that carries its URL. An object typed as
 * something other than an image, or an image with nothing to fetch, is not.
 */
function isUrlOrImage(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!isPlainObject(value)) return false;
  const type = value["@type"];
  const types: unknown[] = Array.isArray(type) ? type : type === undefined ? [] : [type];
  const isImage = (t: unknown) => typeof t === "string" && IMAGE_OBJECT_TYPES.has(bareTypeName(t));
  if (types.length > 0 && !types.some(isImage)) return false;
  return (
    typeof value["@id"] === "string" || !isMissing(value.url) || !isMissing(value.contentUrl)
  );
}

/**
 * A bare JSON-LD reference: an object with an `@id` and nothing else but an
 * optional `@type`. Generators that emit a page as one `@graph` (Yoast,
 * `@unhead/schema-org`) link nodes this way, e.g.
 * `"publisher": {"@id": "https://example.com/#identity"}`.
 */
function isBareReference(value: Record<string, unknown>): boolean {
  if (typeof value["@id"] !== "string") return false;
  for (const key of Object.keys(value)) {
    if (key !== "@id" && key !== "@type") return false;
  }
  return true;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validatePropertyType(
  typeName: string,
  prop: string,
  value: unknown,
  rule: PropertyRule,
  nodes: NodeIndex,
  addIssue: (issue: Omit<SchemaValidationIssue, "type">) => void,
): void {
  if (isMissing(value)) {
    return;
  }

  const addTypeError = (expected: string) => {
    addIssue({
      property: prop,
      message: `Validation: ${typeName}.${prop} must be ${expected}`,
      severity: "invalid",
      path: [prop],
    });
  };

  switch (rule.type) {
    case "string":
      if (typeof value !== "string") addTypeError("a string");
      break;
    case "url":
      if (typeof value !== "string" || !isUrl(value)) {
        addTypeError("a valid URL");
      }
      break;
    case "number":
      if (typeof value !== "number") addTypeError("a number");
      break;
    case "boolean":
      if (typeof value !== "boolean") addTypeError("a boolean");
      break;
    case "array":
      if (!Array.isArray(value)) addTypeError("an array");
      break;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) {
        addTypeError("an object");
      }
      break;
    case "stringOrArray":
      if (
        typeof value !== "string" &&
        !(Array.isArray(value) && value.every((v) => typeof v === "string"))
      ) {
        addTypeError("a string or array of strings");
      }
      break;
    case "urlOrImage":
      if (Array.isArray(value) ? !value.every(isUrlOrImage) : !isUrlOrImage(value)) {
        addTypeError("a URL, an ImageObject, or an array of either");
      }
      break;
    case "objectOrArray":
      if (
        typeof value !== "object" ||
        value === null ||
        (Array.isArray(value) && value.length === 0)
      ) {
        addTypeError("an object or array of objects");
      }
      break;
    case "textOrObjects": {
      const one = (v: unknown) => typeof v === "string" || isPlainObject(v);
      if (Array.isArray(value) ? !value.every(one) : !one(value)) {
        addTypeError("text, an object, or an array of either");
      }
      break;
    }
  }

  if (!rule.required) return;

  const checkObject = (obj: unknown, isLast: boolean) => {
    if (!isPlainObject(obj)) return;
    // A node with an `@id` is checked together with every other description of
    // that id on the page: a field given by any of them is present. A bare
    // reference that names no node on the page is checked as written, so its
    // missing fields still report.
    const targets = describe(obj, nodes);
    for (const key of requiredFor(rule, targets)) {
      if (isLast && rule.lastMayOmit?.includes(key)) continue;
      const elsewhere = rule.alsoAt?.[key];
      if (
        targets.every(
          (target) => isMissing(target[key]) && !(elsewhere && elsewhere(target, nodes)),
        )
      ) {
        addIssue({
          property: `${prop}.${key}`,
          message: `Validation: ${typeName}.${prop}.${key} is required`,
          severity: "missing",
          path: [prop, key],
        });
      }
    }
  };

  if (Array.isArray(value)) {
    const last = rule.lastMayOmit ? lastEntries(value, nodes) : undefined;
    for (const item of value) checkObject(item, last?.has(item) ?? false);
  } else {
    // A single value is a list of one, so it is also the last entry.
    checkObject(value, true);
  }
}

/** The required list that applies to an object, by any `@type` its descriptions give. */
function requiredFor(rule: PropertyRule, targets: Record<string, unknown>[]): string[] {
  const byType = rule.requiredByType;
  if (byType) {
    for (const target of targets) {
      const type = target["@type"];
      for (const t of Array.isArray(type) ? type : [type]) {
        if (typeof t !== "string") continue;
        // Own keys only: a `@type` of "constructor" must not find Object's.
        const name = bareTypeName(t);
        if (Object.hasOwn(byType, name)) return byType[name]!;
      }
    }
  }
  return rule.required ?? [];
}

/** A numeric `position`, from the entry or any description of its `@id`. */
function positionOf(entry: unknown, nodes: NodeIndex): number | undefined {
  for (const node of describe(entry, nodes)) {
    const raw = node.position;
    // Numbers and numeric strings only: coercing an object can run its code.
    const position =
      typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (Number.isFinite(position)) return position;
  }
  return undefined;
}

/**
 * The entries that count as the last of a list. `position` orders a
 * BreadcrumbList, so when any entry carries one the last is the entry (or
 * entries) with the highest; only a list with no positions at all falls back to
 * the order it is written in.
 */
function lastEntries(list: unknown[], nodes: NodeIndex): Set<unknown> {
  const last = new Set<unknown>();
  let topPosition = -Infinity;
  for (const entry of list) {
    const position = positionOf(entry, nodes);
    if (position === undefined) continue;
    if (position > topPosition) {
      topPosition = position;
      last.clear();
    }
    if (position === topPosition) last.add(entry);
  }
  if (last.size === 0 && list.length > 0) last.add(list[list.length - 1]);
  return last;
}

function normalizeTypes(schema: ParsedSchema): string[] {
  const types = schema["@type"];
  if (!types) return [];
  if (Array.isArray(types)) return types.filter((t) => typeof t === "string");
  return typeof types === "string" ? [types] : [];
}

function validateContext(
  schema: ParsedSchema,
  typeName: string,
  addIssue: (issue: Omit<SchemaValidationIssue, "type">) => void,
): void {
  const context = schema["@context"];
  if (!context) {
    addIssue({
      property: "@context",
      message: "Validation: Missing @context",
      severity: "missing",
      path: ["@context"],
    });
    return;
  }

  const contexts = Array.isArray(context) ? context : [context];
  const hasSchemaOrg = contexts.some((entry) => {
    if (typeof entry !== "string") return false;
    try {
      const url = new URL(entry.startsWith("//") ? `https:${entry}` : entry);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (url.hostname === "schema.org" || url.hostname === "www.schema.org")
      );
    } catch {
      return false;
    }
  });
  if (!hasSchemaOrg) {
    addIssue({
      property: "@context",
      message: "Validation: @context should reference schema.org",
      severity: "invalid",
      path: ["@context"],
    });
  }
}

function validateSchema(schema: ParsedSchema, nodes: NodeIndex): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  const baseTypeRaw =
    (Array.isArray(schema["@type"]) ? schema["@type"][0] : schema["@type"]) ?? "Schema";
  const baseType = TYPE_ALIASES[baseTypeRaw] ?? baseTypeRaw;

  const addIssueForType =
    (typeName: string) =>
    (issue: Omit<SchemaValidationIssue, "type">): void => {
      issues.push({ type: typeName, ...issue });
    };

  validateContext(schema, baseType, addIssueForType(baseType));

  const types = normalizeTypes(schema);
  if (types.length === 0) {
    addIssueForType(baseType)({
      property: "@type",
      message: "Validation: Missing @type",
      severity: "missing",
      path: ["@type"],
    });
    return issues;
  }

  for (const rawType of types) {
    const typeName = TYPE_ALIASES[rawType] ?? rawType;
    const addIssue = addIssueForType(typeName);
    const rules = TYPE_RULES[typeName];
    if (!rules) continue;

    for (const required of rules.required ?? []) {
      const value = (schema as Record<string, unknown>)[required];
      if (isMissing(value)) {
        addIssue({
          property: required,
          message: `Validation: ${typeName}.${required} is required`,
          severity: "missing",
          path: [required],
        });
      }
    }

    for (const [prop, rule] of Object.entries(rules.properties ?? {})) {
      const value = (schema as Record<string, unknown>)[prop];
      validatePropertyType(typeName, prop, value, rule, nodes, addIssue);
    }
  }

  return issues;
}

/**
 * Validate every schema on a page. References (`{"@id": …}`) resolve against
 * all of the page's JSON-LD, across `@graph`s and separate script blocks,
 * including the untyped top-level nodes the parser keeps beside the schemas.
 */
export function validateSchemas(
  schemas: ParsedSchema[],
  untypedNodes: readonly Record<string, unknown>[] = [],
): SchemaValidationIssue[] {
  // Untyped top-level nodes are not schemas to validate, but a reference may
  // point at one: `{"@id": "#p", "name": "…"}` in a `@graph` still describes #p.
  const nodes = indexNodes([...schemas, ...untypedNodes]);
  return schemas.flatMap((schema) => validateSchema(schema, nodes));
}
