// SchemaCollection - typed access to parsed JSON-LD schemas

import { LOCAL_BUSINESS_TYPES } from "@squirrelscan/utils/constants";

import type {
  ArticleSchema,
  BreadcrumbListSchema,
  EventSchema,
  FAQPageSchema,
  LocalBusinessSchema,
  OrganizationSchema,
  SchemaValidationIssue,
  ParsedSchema,
  PersonSchema,
  ProductSchema,
  RecipeSchema,
  VideoObjectSchema,
  WebSiteSchema,
} from "./types";

/**
 * Collection of parsed schemas with typed accessors
 */
export class SchemaCollection {
  private _schemas: ParsedSchema[];
  private _errors: string[];
  private _validationErrors: string[];
  private _validationIssues: SchemaValidationIssue[];
  private _raw: string | null;

  // Cached typed schemas (lazy)
  private _article: ArticleSchema | null | undefined;
  private _product: ProductSchema | null | undefined;
  private _organization: OrganizationSchema | null | undefined;
  private _person: PersonSchema | null | undefined;
  private _faq: FAQPageSchema | null | undefined;
  private _breadcrumb: BreadcrumbListSchema | null | undefined;
  private _localBusiness: LocalBusinessSchema | null | undefined;
  private _event: EventSchema | null | undefined;
  private _recipe: RecipeSchema | null | undefined;
  private _video: VideoObjectSchema | null | undefined;
  private _website: WebSiteSchema | null | undefined;

  constructor(
    schemas: ParsedSchema[],
    errors: string[],
    raw: string | null,
    validationIssues: SchemaValidationIssue[] = []
  ) {
    this._schemas = schemas;
    this._errors = errors;
    this._validationIssues = validationIssues;
    this._validationErrors = validationIssues.map((issue) => issue.message);
    this._raw = raw;
  }

  /**
   * All parsed schemas
   */
  get all(): ParsedSchema[] {
    return this._schemas;
  }

  /**
   * All @type values (backwards compat with SchemaData.types)
   */
  get types(): string[] {
    const types: string[] = [];
    for (const schema of this._schemas) {
      if (Array.isArray(schema["@type"])) {
        types.push(...schema["@type"]);
      } else if (schema["@type"]) {
        types.push(schema["@type"]);
      }
    }
    return [...new Set(types)];
  }

  /**
   * Whether all schemas parsed successfully
   */
  get valid(): boolean {
    return this._errors.length === 0 && this._validationIssues.length === 0;
  }

  /**
   * Parse errors
   */
  get errors(): string[] {
    return this._errors;
  }

  /**
   * Schema.org validation errors
   */
  get validationErrors(): string[] {
    return this._validationErrors;
  }

  /**
   * Schema.org validation issues with context
   */
  get validationIssues(): SchemaValidationIssue[] {
    return this._validationIssues;
  }

  /**
   * Raw JSON-LD content
   */
  get raw(): string | null {
    return this._raw;
  }

  /**
   * Check if any schema has the given type
   */
  hasType(type: string): boolean {
    const lowerType = type.toLowerCase();
    return this._schemas.some((schema) => {
      const schemaType = schema["@type"];
      if (Array.isArray(schemaType)) {
        return schemaType.some((t) => t.toLowerCase() === lowerType);
      }
      return schemaType?.toLowerCase() === lowerType;
    });
  }

  /**
   * Get first schema matching type
   */
  getByType<T extends ParsedSchema>(type: string): T | null {
    const lowerType = type.toLowerCase();
    const found = this._schemas.find((schema) => {
      const schemaType = schema["@type"];
      if (Array.isArray(schemaType)) {
        return schemaType.some((t) => t.toLowerCase() === lowerType);
      }
      return schemaType?.toLowerCase() === lowerType;
    });
    return (found as T) ?? null;
  }

  /**
   * Get all schemas matching type
   */
  getAllByType<T extends ParsedSchema>(type: string): T[] {
    const lowerType = type.toLowerCase();
    return this._schemas.filter((schema) => {
      const schemaType = schema["@type"];
      if (Array.isArray(schemaType)) {
        return schemaType.some((t) => t.toLowerCase() === lowerType);
      }
      return schemaType?.toLowerCase() === lowerType;
    }) as T[];
  }

  // ============================================
  // TYPED ACCESSORS (lazy, cached)
  // ============================================

  /**
   * Article, BlogPosting, NewsArticle, or TechArticle schema
   */
  get article(): ArticleSchema | null {
    if (this._article === undefined) {
      this._article =
        this.getByType<ArticleSchema>("Article") ??
        this.getByType<ArticleSchema>("BlogPosting") ??
        this.getByType<ArticleSchema>("NewsArticle") ??
        this.getByType<ArticleSchema>("TechArticle");
    }
    return this._article;
  }

  /**
   * Product or ProductGroup schema
   */
  get product(): ProductSchema | null {
    if (this._product === undefined) {
      this._product =
        this.getByType<ProductSchema>("Product") ??
        this.getByType<ProductSchema>("ProductGroup");
    }
    return this._product;
  }

  /**
   * Organization schema (not LocalBusiness)
   */
  get organization(): OrganizationSchema | null {
    if (this._organization === undefined) {
      this._organization =
        this.getByType<OrganizationSchema>("Organization") ??
        this.getByType<OrganizationSchema>("Corporation");
    }
    return this._organization;
  }

  /**
   * Person schema
   */
  get person(): PersonSchema | null {
    if (this._person === undefined) {
      this._person = this.getByType<PersonSchema>("Person");
    }
    return this._person;
  }

  /**
   * FAQPage schema
   */
  get faq(): FAQPageSchema | null {
    if (this._faq === undefined) {
      this._faq = this.getByType<FAQPageSchema>("FAQPage");
    }
    return this._faq;
  }

  /**
   * BreadcrumbList schema
   */
  get breadcrumb(): BreadcrumbListSchema | null {
    if (this._breadcrumb === undefined) {
      this._breadcrumb = this.getByType<BreadcrumbListSchema>("BreadcrumbList");
    }
    return this._breadcrumb;
  }

  /**
   * LocalBusiness schema (or subtypes like Restaurant, Store, etc.)
   */
  get localBusiness(): LocalBusinessSchema | null {
    if (this._localBusiness === undefined) {
      // Check all Schema.org LocalBusiness subtypes
      for (const type of LOCAL_BUSINESS_TYPES) {
        const found = this.getByType<LocalBusinessSchema>(type);
        if (found) {
          this._localBusiness = found;
          break;
        }
      }
      this._localBusiness ??= null;
    }
    return this._localBusiness;
  }

  /**
   * Event schema
   */
  get event(): EventSchema | null {
    if (this._event === undefined) {
      this._event =
        this.getByType<EventSchema>("Event") ??
        this.getByType<EventSchema>("BusinessEvent") ??
        this.getByType<EventSchema>("MusicEvent") ??
        this.getByType<EventSchema>("SportsEvent") ??
        this.getByType<EventSchema>("TheaterEvent") ??
        this.getByType<EventSchema>("Festival") ??
        this.getByType<EventSchema>("Course");
    }
    return this._event;
  }

  /**
   * Recipe schema
   */
  get recipe(): RecipeSchema | null {
    if (this._recipe === undefined) {
      this._recipe = this.getByType<RecipeSchema>("Recipe");
    }
    return this._recipe;
  }

  /**
   * VideoObject schema
   */
  get video(): VideoObjectSchema | null {
    if (this._video === undefined) {
      this._video = this.getByType<VideoObjectSchema>("VideoObject");
    }
    return this._video;
  }

  /**
   * WebSite schema
   */
  get website(): WebSiteSchema | null {
    if (this._website === undefined) {
      this._website = this.getByType<WebSiteSchema>("WebSite");
    }
    return this._website;
  }
}

/**
 * Rehydrate SchemaCollection from serialized JSON data.
 * When parsedData is deserialized from storage, schema is a plain object
 * without getters. This restores the proper class instance.
 */
export function schemaCollectionFromJSON(data: unknown): SchemaCollection {
  if (!data || typeof data !== "object") {
    return EMPTY_SCHEMA_COLLECTION;
  }
  const obj = data as Record<string, unknown>;
  return new SchemaCollection(
    (obj._schemas ?? obj.all ?? []) as ParsedSchema[],
    (obj._errors ?? obj.errors ?? []) as string[],
    (obj._raw ?? obj.raw ?? null) as string | null,
    (obj._validationIssues ??
      obj.validationIssues ??
      []) as SchemaValidationIssue[]
  );
}

/**
 * Empty schema collection for pages without schemas
 */
export const EMPTY_SCHEMA_COLLECTION = new SchemaCollection([], [], null, []);
