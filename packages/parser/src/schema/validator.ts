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
  | "objectOrArray";

interface PropertyRule {
  type: PropertyType;
  required?: string[];
  item?: PropertyRule;
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
    required: ["headline", "image", "datePublished", "author", "publisher"],
    properties: {
      headline: { type: "string" },
      image: { type: "urlOrImage" },
      datePublished: { type: "string" },
      author: { type: "objectOrArray", required: ["name"] },
      publisher: { type: "object", required: ["name", "logo"] },
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
      itemListElement: {
        type: "array",
        item: { type: "object", required: ["position", "name", "item"] },
      },
    },
  },
  FAQPage: {
    required: ["mainEntity"],
    properties: {
      mainEntity: {
        type: "array",
        item: { type: "object", required: ["name", "acceptedAnswer"] },
      },
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
      recipeIngredient: { type: "array" },
      recipeInstructions: { type: "array" },
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

/**
 * Index every node inside the page's typed schemas that describes an entity
 * under an `@id`, at any depth. A node that is itself only a reference (`@id`,
 * optionally `@type`) describes nothing and is skipped. Iterative so a deeply
 * nested document cannot overflow the stack.
 */
function indexNodes(schemas: ParsedSchema[]): NodeIndex {
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
  }

  if (!rule.required) return;

  const checkObject = (obj: unknown) => {
    if (!isPlainObject(obj)) return;
    // A node with an `@id` is checked together with every other description of
    // that id on the page: a field given by any of them is present. A bare
    // reference that names no node on the page is checked as written, so its
    // missing fields still report.
    const id = obj["@id"];
    const targets = typeof id === "string" ? [obj, ...(nodes.get(id) ?? [])] : [obj];
    for (const key of rule.required ?? []) {
      if (targets.every((target) => isMissing(target[key]))) {
        addIssue({
          property: `${prop}.${key}`,
          message: `Validation: ${typeName}.${prop}.${key} is required`,
          severity: "missing",
          path: [prop, key],
        });
      }
    }
  };

  if (rule.type === "object") {
    checkObject(value);
  } else if (rule.type === "objectOrArray") {
    if (Array.isArray(value)) {
      for (const item of value) {
        checkObject(item);
      }
    } else {
      checkObject(value);
    }
  } else if (rule.type === "array" && rule.item?.type === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        checkObject(item);
      }
    }
  }
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
 * all of the page's JSON-LD, across `@graph`s and separate script blocks.
 */
export function validateSchemas(schemas: ParsedSchema[]): SchemaValidationIssue[] {
  const nodes = indexNodes(schemas);
  return schemas.flatMap((schema) => validateSchema(schema, nodes));
}
