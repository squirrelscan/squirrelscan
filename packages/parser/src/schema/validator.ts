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
      image: { type: "stringOrArray" },
      datePublished: { type: "string" },
      author: { type: "objectOrArray", required: ["name"] },
      publisher: { type: "object", required: ["name", "logo"] },
    },
  },
  Product: {
    required: ["name", "image", "offers"],
    properties: {
      name: { type: "string" },
      image: { type: "stringOrArray" },
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
      logo: { type: "stringOrArray" },
    },
  },
  LocalBusiness: {
    required: ["name", "url", "address"],
    properties: {
      name: { type: "string" },
      url: { type: "url" },
      address: { type: "object" },
      image: { type: "stringOrArray" },
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
      image: { type: "stringOrArray" },
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
  addIssue: (issue: Omit<SchemaValidationIssue, "type">) => void
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
    if (!obj || typeof obj !== "object") return;
    for (const key of rule.required ?? []) {
      const val = (obj as Record<string, unknown>)[key];
      if (isMissing(val)) {
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
  addIssue: (issue: Omit<SchemaValidationIssue, "type">) => void
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
    return entry.includes("schema.org");
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

function validateSchema(schema: ParsedSchema): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  const baseTypeRaw =
    (Array.isArray(schema["@type"]) ? schema["@type"][0] : schema["@type"]) ??
    "Schema";
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
      validatePropertyType(typeName, prop, value, rule, addIssue);
    }
  }

  return issues;
}

export function validateSchemas(
  schemas: ParsedSchema[]
): SchemaValidationIssue[] {
  return schemas.flatMap((schema) => validateSchema(schema));
}
