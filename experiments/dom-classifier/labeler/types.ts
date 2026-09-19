/**
 * Versioned, additive DOM taxonomy. v1-v3 records retain their original
 * canonical strings; v2 only adds labels and never projects an old label to a
 * new one. An omitted axis is unobserved, while `unknown` is an explicit,
 * singleton observation for that axis.
 */
export const TAXONOMY_REVISION = "dom-taxonomy-v2" as const;

export const ROLES = [
  "site_header",
  "footer",
  "navigation",
  "main_content",
  "article_header",
  "card",
  "aside",
  "form",
  "consent_banner",
  "unknown",
] as const;

export const CONTEXTS = ["site", "article", "main", "header", "footer", "unknown"] as const;
/** Where a component sits in the page. Multiple regions are permitted. */
export const REGIONS = [
  "site_header",
  "footer",
  "sidebar",
  "main_content",
  "article_header",
  "hero",
  "top_banner",
  "bottom_banner",
  "overlay",
  "article_body",
  "advertisement",
  "product_gallery",
  "product_buy_box",
  "product_details",
  "product_reviews",
  "author_bio",
  "related_content",
  "comments",
  "unknown",
] as const;
/** What a component does. Multiple functions are permitted. */
export const FUNCTIONS = ["navigation", "card", "form", "consent_banner", "unknown"] as const;
/** v3: the observed component shape, independent of layout and purpose. */
export const COMPONENT_TYPES = [
  "button",
  "link",
  "input",
  "checkbox",
  "radio",
  "select",
  "toggle",
  "heading",
  "text",
  "icon",
  "image",
  "search",
  "dropdown",
  "tabs",
  "accordion",
  "pagination",
  "card",
  "form",
  "list",
  "table",
  "article",
  "media",
  "hero",
  "navigation_menu",
  "content_section",
  "layout_container",
  "dialog",
  "drawer",
  "tooltip",
  "notification",
  "banner",
  "popover",
  "ad_unit",
  "media_gallery",
  "purchase_panel",
  "specification_list",
  "rating_summary",
  "review_list",
  "video_player",
  "audio_player",
  "author_card",
  "comment_thread",
  "unknown",
] as const;
/** v3: user-observed purpose; this intentionally does not describe source code. */
export const PURPOSES = [
  "navigation",
  "submit",
  "search",
  "filter",
  "consent",
  "share",
  "account",
  "dismiss",
  "download",
  "toggle",
  "promotion",
  "announcement",
  "authentication",
  "subscription",
  "feedback",
  "support",
  "advertising",
  "purchase",
  "media_playback",
  "review",
  "information",
  "editorial",
  "instruction",
  "product_information",
  "comparison",
  "social_proof",
  "unknown",
] as const;
export const OBSERVED_STATES = [
  "visible",
  "disabled",
  "expanded",
  "selected",
  "open",
  "sticky",
  "unknown",
] as const;
/** Page-level review taxonomy. It is deliberately separate from DOM labels. */
export const PAGE_TYPES = [
  "homepage",
  "landing_page",
  "campaign",
  "about",
  "team",
  "contact",
  "location",
  "pricing",
  "product_detail",
  "product_listing",
  "features",
  "service",
  "solution",
  "use_case",
  "industry",
  "integrations",
  "integration_detail",
  "download",
  "docs_index",
  "docs_article",
  "tutorial",
  "api_reference",
  "blog_index",
  "blog_post",
  "news_index",
  "news_article",
  "category",
  "tag",
  "archive",
  "author",
  "changelog",
  "releases",
  "release_notes",
  "careers",
  "job",
  "event_index",
  "event_detail",
  "webinar",
  "video",
  "gallery",
  "community",
  "forum_thread",
  "search_results",
  "account",
  "login",
  "signup",
  "checkout",
  "cart",
  "confirmation",
  "legal",
  "privacy",
  "terms",
  "policy",
  "accessibility",
  "support",
  "faq",
  "status",
  "maintenance",
  "portfolio",
  "case_study",
  "comparison",
  "review",
  "directory",
  "profile",
  "dashboard",
  "error",
  "other",
  "unknown",
] as const;
export const CONTENT_KINDS = [
  "article",
  "product",
  "person",
  "event",
  "review",
  "offer",
  "job",
  "software",
  "service",
  "organization",
  "reference",
  "media",
  "other",
  "unknown",
] as const;
/** Authoritative picker grouping for page types; clients should not duplicate it. */
export const PAGE_TYPE_GROUPS = [
  {
    id: "entry",
    label: "Entry and company",
    values: ["homepage", "landing_page", "campaign", "about", "team", "contact", "location"],
  },
  {
    id: "commercial",
    label: "Commercial",
    values: [
      "pricing",
      "product_detail",
      "product_listing",
      "features",
      "service",
      "solution",
      "use_case",
      "industry",
      "integrations",
      "integration_detail",
      "download",
      "comparison",
      "review",
    ],
  },
  {
    id: "documentation",
    label: "Documentation and releases",
    values: [
      "docs_index",
      "docs_article",
      "tutorial",
      "api_reference",
      "changelog",
      "releases",
      "release_notes",
    ],
  },
  {
    id: "publishing",
    label: "Publishing and media",
    values: [
      "blog_index",
      "blog_post",
      "news_index",
      "news_article",
      "category",
      "tag",
      "archive",
      "author",
      "portfolio",
      "case_study",
      "video",
      "gallery",
    ],
  },
  {
    id: "community",
    label: "Community and events",
    values: [
      "careers",
      "job",
      "event_index",
      "event_detail",
      "webinar",
      "community",
      "forum_thread",
      "directory",
      "profile",
    ],
  },
  {
    id: "transaction",
    label: "Account and transaction",
    values: ["account", "login", "signup", "checkout", "cart", "confirmation", "dashboard"],
  },
  {
    id: "utility",
    label: "Utility and policy",
    values: [
      "search_results",
      "legal",
      "privacy",
      "terms",
      "policy",
      "accessibility",
      "support",
      "faq",
      "status",
      "maintenance",
      "error",
      "other",
      "unknown",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  values: readonly (typeof PAGE_TYPES)[number][];
}>;
export const COMPONENT_SUBTYPES: Partial<
  Record<(typeof COMPONENT_TYPES)[number], readonly string[]>
> = {
  button: ["primary", "secondary", "icon"],
  input: ["text", "search", "email", "password", "number"],
  card: ["product", "article", "result"],
  navigation_menu: ["main", "footer", "breadcrumb"],
  form: ["search", "sign_in", "contact", "newsletter", "checkout"],
  /** This describes modal behavior, while observedState records whether it is currently open. */
  dialog: ["modal", "non_modal"],
  banner: ["announcement", "promotional", "cookie_consent"],
  ad_unit: ["display", "sponsored_content"],
  media_gallery: ["product", "editorial", "portfolio"],
  purchase_panel: ["product", "subscription"],
  drawer: ["navigation", "cart", "preferences"],
  popover: ["menu", "help"],
  content_section: [
    "features",
    "benefits",
    "pricing",
    "testimonials",
    "faq",
    "logo_cloud",
    "team",
    "contact",
    "related_content",
    "call_to_action",
  ],
};
export const STATEFUL_COMPONENT_TYPES = {
  visible: ["dialog", "drawer", "tooltip", "notification", "banner", "popover", "dropdown"],
  disabled: ["button", "input", "checkbox", "radio", "select", "toggle"],
  expanded: ["dropdown", "tabs", "accordion"],
  selected: ["tabs", "pagination", "select", "radio", "toggle"],
  open: ["dialog", "drawer", "popover", "dropdown"],
  sticky: ["navigation_menu", "banner"],
} as const;
export const BOUNDARIES = ["correct", "too_broad", "too_narrow", "mixed", "unsure"] as const;
export const DECISIONS = ["label", "accept", "reject", "unsure"] as const;

export type Role = (typeof ROLES)[number];
export type Context = (typeof CONTEXTS)[number];
export type Region = (typeof REGIONS)[number];
export type FunctionLabel = (typeof FUNCTIONS)[number];
export type ComponentType = (typeof COMPONENT_TYPES)[number];
export type Purpose = (typeof PURPOSES)[number];
export type ObservedState = (typeof OBSERVED_STATES)[number];
export type PageType = (typeof PAGE_TYPES)[number];
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type ComponentProjection = {
  componentType: ComponentType;
  provenance: "legacy-v1-v2";
};
export type PurposeProjection = {
  purposes: Purpose[];
  provenance: "legacy-v1-v2";
};
export type Boundary = (typeof BOUNDARIES)[number];
export type Decision = (typeof DECISIONS)[number];
export const MODEL_REVIEWS = ["accept", "correct", "reject"] as const;
export type ModelReview = (typeof MODEL_REVIEWS)[number];

/**
 * An extra capture set mounted beside the primary one.
 *
 * A cohort brings its own read-only `captures/` directory and optional
 * `model-suggestions.jsonl`. Labels for every cohort are still appended to the
 * primary data directory's journals, stamped with the cohort id, so mounting a
 * cohort never rewrites or relocates existing labels.
 */
export type CohortSource = { id: string; dir: string };
/** Captures that live in the primary data directory carry this cohort id. */
export const PRIMARY_COHORT_ID = "primary" as const;
/** A cohort id is an opaque short slug, never a path. */
export const COHORT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Rect = { x: number; y: number; width: number; height: number };

export type WeakSuggestion = {
  role: Role;
  provenance: "weak";
  reason: string;
};

export type CapturedNode = {
  id: string;
  parentId: string | null;
  tag: string;
  role: string | null;
  text: string;
  selector: string;
  rect: Rect;
  depth: number;
  suggestion: WeakSuggestion | null;
};

export type CapturedPage = {
  id: string;
  url: string;
  title: string;
  capturedAt: string;
  contentHash: string;
  /** Hash of this immutable rendered capture; currently identical to contentHash. */
  captureHash: string;
  width: number;
  height: number;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  nodes: CapturedNode[];
  screenshotUrl: string;
  split: "training-review";
  /** The source document's full height before the bounded screenshot crop. */
  documentHeight?: number;
  /** True when the capture stopped at the configured full-page height ceiling. */
  heightCapped?: boolean;
  /** Whether the fresh browser render reached a quiet network state before capture. */
  renderSettled?: "networkidle" | "bounded_timeout";
  /** Capture provenance, never a human label. Absent on pre-corpus captures. */
  sourceKind?: "fresh_capture" | "historical_replay";
  /** Original crawl time for a replay, distinct from the rendered `capturedAt`. */
  originalCrawledAt?: string | null;
  /** Original public URL if rendering used a replay or hybrid asset source. */
  sourceUrl?: string | null;
  /** Private opaque corpus reference; it is not an on-disk path. */
  corpusRef?: string | null;
  /** Known content date when distinct from the replay and rendering dates. */
  contentOriginDate?: string | null;
  assetMode?: "live" | "hybrid" | "offline";
};

export type AnnotationInput = {
  pageId: string;
  nodeId: string;
  decision: Decision;
  role?: Role;
  context?: Context;
  /**
   * Additive v2 labels. Empty means this axis is unlabeled, not negative.
   *
   * Read-only: the store validates and copies every axis (see `checkedAxis`)
   * and never writes back, so a caller may pass a frozen or `as const` array.
   */
  regions?: readonly Region[];
  functions?: readonly FunctionLabel[];
  componentType?: ComponentType;
  componentSubtype?: string;
  /** States seen by the annotator, never inferred by the capture process. */
  observedState?: readonly ObservedState[];
  purposes?: readonly Purpose[];
  comment?: string;
  boundary: Boundary;
  clientRequestId: string;
  /** Optional optimistic-concurrency check supplied by a current page response. */
  captureHash?: string;
  supersedes?: string;
  /** Immutable model row the reviewer explicitly acted on, if any. */
  modelSuggestionId?: string;
  /** Human review of that model row; separate from a weak-rule decision. */
  modelReview?: ModelReview;
};

export type Annotation = Omit<
  AnnotationInput,
  | "role"
  | "context"
  | "regions"
  | "functions"
  | "componentType"
  | "componentSubtype"
  | "observedState"
  | "purposes"
  | "comment"
  | "captureHash"
  | "supersedes"
> & {
  role: Role | null;
  context: Context | null;
  regions: Region[];
  functions: FunctionLabel[];
  /** v1 records expose compatibility projections; v2 records were labeled on both axes. */
  labelSchemaVersion: 1 | 2;
  componentType: ComponentType | null;
  componentSubtype: string | null;
  observedState: ObservedState[];
  purposes: Purpose[];
  /** 0 means a v1/v2 compatibility projection, not a new human v3 claim. */
  componentSchemaVersion: 0 | 3;
  componentProjection: ComponentProjection | null;
  purposeProjection: PurposeProjection | null;
  comment: string | null;
  captureHash: string;
  supersedes: string | null;
  modelSuggestionId: string | null;
  modelReview: ModelReview | null;
  id: string;
  source: "human";
  gold: false;
  timestamp: string;
  /** Which mounted capture set this label belongs to. Absent on pre-cohort rows. */
  cohortId?: string;
};

export type PageAnnotationInput = {
  pageId: string;
  decision: "label" | "unsure";
  /** Read-only for the same reason as `AnnotationInput`'s axes. */
  pageTypes?: readonly PageType[];
  contentKinds?: readonly ContentKind[];
  comment?: string;
  clientRequestId: string;
  captureHash?: string;
  supersedes?: string;
  modelSuggestionId?: string;
  modelReview?: ModelReview;
};

export type PageAnnotation = Omit<
  PageAnnotationInput,
  "pageTypes" | "contentKinds" | "comment" | "captureHash" | "supersedes"
> & {
  id: string;
  pageTypes: PageType[];
  contentKinds: ContentKind[];
  comment: string | null;
  captureHash: string;
  supersedes: string | null;
  modelSuggestionId: string | null;
  modelReview: ModelReview | null;
  source: "human";
  gold: false;
  timestamp: string;
  /** Which mounted capture set this label belongs to. Absent on pre-cohort rows. */
  cohortId?: string;
};

/** A standalone rejection preserves feedback without manufacturing a human label. */
export type ModelReviewInput = {
  pageId: string;
  nodeId: string | null;
  modelSuggestionId: string;
  review: "reject";
  comment?: string;
  clientRequestId: string;
  captureHash?: string;
};

export type ModelReviewRecord = Omit<ModelReviewInput, "comment" | "captureHash"> & {
  id: string;
  comment: string | null;
  captureHash: string;
  source: "human";
  timestamp: string;
  /** Which mounted capture set this label belongs to. Absent on pre-cohort rows. */
  cohortId?: string;
};

/** An append-only reversal of one effective human review action. */
export type ReviewActionKind = "annotation" | "page_annotation" | "model_review";
export type ReviewUndoRecord = {
  id: string;
  actionKind: ReviewActionKind;
  actionId: string;
  pageId: string;
  nodeId: string | null;
  captureHash: string;
  timestamp: string;
};

/** A probability from a Noul judgment. It is not a confidence score. */
export type ModelLabelProbability<T extends string> = {
  label: T;
  yesProbability: number;
};

/** A Choice judgment keeps both the selected option and its full distribution. */
export type ModelComponentTypeChoice = {
  choice: ComponentType;
  distribution: Array<{ label: ComponentType; probability: number }>;
  confidence: number;
};

/**
 * Immutable offline model output. This is deliberately separate from captured
 * pages and human annotations: omitted axes are unlabeled, never negative.
 */
export type ModelSuggestion = {
  schemaVersion: 1;
  id: string;
  pageId: string;
  /** Null means this is a page-level prediction rather than a DOM-node prediction. */
  nodeId: string | null;
  captureHash: string;
  provider: "typesafe";
  modelId: string;
  modelRevision: string;
  promptRevision: string;
  /** Present for taxonomy-aware sidecars; omitted legacy sidecars remain valid. */
  taxonomyRevision?: typeof TAXONOMY_REVISION;
  snapshotHash: string;
  rawAnswers: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Offline output may be shown, but must never be treated as a human label. */
  provisional: boolean;
  /** Compatibility scalar for a provider's primary raw class, when supplied. */
  rawClass?: string;
  score?: number;
  mappedLabels: {
    regions?: Region[];
    functions?: FunctionLabel[];
    purposes?: Purpose[];
    componentType?: ComponentType;
    pageTypes?: PageType[];
    contentKinds?: ContentKind[];
  };
  axisProbabilities?: {
    regions?: ModelLabelProbability<Region>[];
    functions?: ModelLabelProbability<FunctionLabel>[];
    purposes?: ModelLabelProbability<Purpose>[];
    pageTypes?: ModelLabelProbability<PageType>[];
    contentKinds?: ModelLabelProbability<ContentKind>[];
  };
  componentTypeChoice?: ModelComponentTypeChoice;
  createdAt: string;
};

/** Read-only projection over the append-only journals for the current captures. */
export type LabelerStats = {
  generatedAt: string;
  pages: {
    total: number;
    /** Pages with a current positive page or element label. */
    labelled: number;
    /** Latest positive page-level classification records, separate from element work. */
    currentPageLabels: number;
  };
  elements: {
    total: number;
    /** Latest `label` or `accept` actions; `reject` and `unsure` are not positive labels. */
    currentHumanLabels: number;
    /** Positive `label` actions with no model suggestion binding. */
    latestManualLabels: number;
  };
  suggestions: {
    total: number;
    page: number;
    element: number;
    pending: number;
    reviewed: { accepted: number; corrected: number; rejected: number };
  };
  /**
   * Per-cohort counts, keyed by cohort id. Always carries the primary cohort so
   * a single-cohort install reads the same as before, plus one entry per mounted
   * cohort. Labels written before cohorts existed count under the primary id.
   */
  byCohort: Record<
    string,
    {
      pages: number;
      labelledPages: number;
      currentHumanLabels: number;
      /**
       * Per annotator, how often a human sided with it or rejected it. This is
       * what makes agreement-with-human comparable between annotators.
       */
      bySource: Record<string, { accepted: number; rejected: number }>;
    }
  >;
};
