// What the `schema/entity-*` rules read off an entity map, in one place.
//
// The rules (`@squirrelscan/rules`) and the publish projection
// (`./entity-map-project`) must agree on what a problem entity is. The rules say
// a finding exists; the projection decides which nodes survive into the copy the
// finding links to. Two hand-kept copies of that judgement drift without a test
// failing, and the cost of drift is a report that states a finding whose entity
// is not in the graph. So the predicates live here, the rules import them, and
// the projection calls `entityProblemNodes`.
//
// Pure functions over `EntityMap`, no I/O.

import type { EntityMap, EntityMapNode } from "./entity-map";

/** Types whose identity a search engine is expected to reconcile site-wide. */
export const IDENTITY_TYPES = [
  "Organization",
  "LocalBusiness",
  "Person",
  "WebSite",
] as const;

/**
 * `@type` values that are a LocalBusiness or one of its subtypes.
 *
 * An explicit table rather than a suffix pattern. A pattern is tempting because
 * most subtype names end in Business, Store or Service, and it is wrong in both
 * directions: it misses `BankOrCreditUnion` and `Dentist`, which are subtypes
 * and end in neither, and it accepts `OnlineStore`, which is not one — an
 * online-only shop has no premises, which is the whole point of the type.
 *
 * Taken from the schema.org LocalBusiness hierarchy. Deliberately not
 * exhaustive to its last leaf: the deepest subtypes inherit from one of these
 * and a site declaring `Hairdresser` alone rather than with a parent is rare
 * enough to be worth missing rather than guessing at.
 */
const LOCAL_BUSINESS_TYPES: ReadonlySet<string> = new Set([
  "LocalBusiness",
  "AnimalShelter",
  "ArchiveOrganization",
  "AutomotiveBusiness",
  "AutoBodyShop",
  "AutoDealer",
  "AutoPartsStore",
  "AutoRental",
  "AutoRepair",
  "AutoWash",
  "BankOrCreditUnion",
  "Bakery",
  "BarOrPub",
  "BeautySalon",
  "BedAndBreakfast",
  "BikeStore",
  "BookStore",
  "Brewery",
  "CafeOrCoffeeShop",
  "Campground",
  "ChildCare",
  "ClothingStore",
  "ComputerStore",
  "Dentist",
  "DaySpa",
  "DryCleaningOrLaundry",
  "ElectronicsStore",
  "Electrician",
  "EmergencyService",
  "EmploymentAgency",
  "EntertainmentBusiness",
  "FastFoodRestaurant",
  "FinancialService",
  "Florist",
  "FoodEstablishment",
  "FurnitureStore",
  "GardenStore",
  "GasStation",
  "GeneralContractor",
  "GroceryStore",
  "HVACBusiness",
  "HairSalon",
  "HardwareStore",
  "HealthAndBeautyBusiness",
  "HobbyShop",
  "HomeAndConstructionBusiness",
  "HomeGoodsStore",
  "Hostel",
  "Hotel",
  "HousePainter",
  "IceCreamShop",
  "InsuranceAgency",
  "JewelryStore",
  "LegalService",
  "Library",
  "LiquorStore",
  "Locksmith",
  "LodgingBusiness",
  "MedicalBusiness",
  "MedicalClinic",
  "MensClothingStore",
  "MobilePhoneStore",
  "Motel",
  "MovingCompany",
  "MusicStore",
  "NailSalon",
  "Notary",
  "NightClub",
  "OfficeEquipmentStore",
  "Optician",
  "PetStore",
  "Pharmacy",
  "Physician",
  "Plumber",
  "ProfessionalService",
  "RealEstateAgent",
  "RecyclingCenter",
  "Resort",
  "Restaurant",
  "RoofingContractor",
  "SelfStorage",
  "ShoeStore",
  "SkiResort",
  "SportingGoodsStore",
  "SportsActivityLocation",
  "Store",
  "TattooParlor",
  "TouristInformationCenter",
  "ToyStore",
  "TravelAgency",
  "VeterinaryCare",
  "WholesaleStore",
  "Attorney",
]);

export function isLocalBusinessType(type: string): boolean {
  return LOCAL_BUSINESS_TYPES.has(type);
}

/** Stable, locale-independent ordering. `localeCompare` is not portable. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every page an entity is declared on, including the ones past the cap. */
export function pageTotal(node: EntityMapNode): number {
  return node.pages.length + node.morePages;
}

/**
 * The identity an entity keeps across gaining or losing an `@id`.
 *
 * `JSON.stringify` of the sorted type set and the normalised name, never a
 * delimiter join: `@type` is a site-controlled string, so types `["A+B"]` and
 * `["A","B"]` would otherwise produce the same signature and pair two unrelated
 * entities. The same signature the engine's diff and the CLI's filters use,
 * deliberately, so the three agree about what "the same entity" means.
 *
 * Null for an unnamed entity: without a name there is nothing to reconcile by,
 * and treating every unnamed node as one identity would merge the site's whole
 * graph.
 */
export function identityOf(node: EntityMapNode): string | null {
  if (!node.name) return null;
  const types = [...new Set(node.types)].sort(compareStrings);
  return JSON.stringify([types, normaliseName(node.name)]);
}

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The site's primary Organization or LocalBusiness, or null.
 *
 * "Primary" is the most-declared one, ties broken on key so two equally
 * declared organizations resolve the same way on every run. A site with two is
 * usually a split identity, which is `schema/entity-split-identity`'s finding,
 * not this helper's problem to solve.
 */
export function primaryOrganization(map: EntityMap): EntityMapNode | null {
  const candidates = map.nodes.filter((node) =>
    node.types.some(
      (type) => type === "Organization" || type === "Corporation" || isLocalBusinessType(type)
    )
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => b.occurrences - a.occurrences || compareStrings(a.key, b.key)
  )[0]!;
}

/**
 * Types that describe or ARE the page they sit on, and are correctly
 * unreferenced.
 *
 * Two groups, and the second is the one that matters. A `WebPage`, its
 * `BreadcrumbList`, its `FAQPage` describe the page: nothing else on the site
 * should point at them. An `Article` is the page's own subject: it is what the
 * page is, and expecting some other node to reference it is backwards.
 *
 * Without the second group this rule fires on every blog post on the web.
 * Measured against a real 40-page crawl of kinsta.com, 73 of the 79 entities it
 * would otherwise report were breadcrumbs and articles — noise that would have
 * buried the six findings worth reading.
 */
export const PAGE_SUBJECT_TYPES = [
  // Describe the page.
  "WebPage",
  "ItemPage",
  "CollectionPage",
  "AboutPage",
  "ContactPage",
  "CheckoutPage",
  "SearchResultsPage",
  "ProfilePage",
  "BreadcrumbList",
  "FAQPage",
  "Question",
  "Answer",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  "MedicalWebPage",
  "QAPage",
  "RealEstateListing",
  // Are the page. A product detail page IS the product, a recipe page IS the
  // recipe: expecting some other node to reference them is backwards, and the
  // finding would be the site's page count rather than anything actionable.
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  "ScholarlyArticle",
  "Report",
  "LiveBlogPosting",
  "Recipe",
  "HowTo",
  "Product",
  "ProductGroup",
  "Event",
  "Course",
  "JobPosting",
  "SoftwareApplication",
  "Book",
  "Movie",
  "Dataset",
  "VideoObject",
];

/**
 * Schemes that identify a thing globally without being a web address.
 *
 * A library's `urn:isbn:9780140328721` and a dataset's `doi:` are proper
 * identifiers: unique, stable and the same on every page. They are not what
 * this rule is about, which is an identifier that silently means something
 * different on each page.
 */
const GLOBAL_ID_SCHEMES = new Set(["urn:", "doi:", "info:", "tag:", "isbn:"]);

/**
 * True when an `@id` identifies the same thing wherever it appears.
 *
 * An http(s) URL with a host does. So does a URN or a DOI. What does not is a
 * bare fragment, a relative path, or anything that does not parse as a URI at
 * all — those resolve against the page and quietly differ on each one, which
 * is the defect.
 *
 * `mailto:` is excluded deliberately. It parses as absolute and is stable, and
 * an email address is a way of contacting a thing rather than a name for it.
 */
export function isStableIdentifier(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return parsed.host !== "";
  }
  return GLOBAL_ID_SCHEMES.has(parsed.protocol);
}

/** Share of crawled pages a LocalBusiness must be declared on to count as per-page. */
export const LOCAL_BUSINESS_PER_PAGE_SHARE = 0.8;

/** Fewest crawled pages at which per-page repetition can be told from coverage. */
export const LOCAL_BUSINESS_MIN_PAGES = 5;

/**
 * Share of publisher references one publisher must hold for the rest to read as
 * drift rather than as a site that genuinely has several.
 */
export const PUBLISHER_MAJORITY_SHARE = 0.8;

/** Keys that at least one edge points at. */
export function referencedKeys(map: EntityMap): Set<string> {
  return new Set(map.edges.map((edge) => edge.target));
}

/** Group entities by their identity signature. Unnamed entities are dropped. */
export function groupByIdentity(map: EntityMap): Map<string, EntityMapNode[]> {
  return groupNodesByIdentity(map.nodes);
}

function groupNodesByIdentity(nodes: readonly EntityMapNode[]): Map<string, EntityMapNode[]> {
  const out = new Map<string, EntityMapNode[]>();
  for (const node of nodes) {
    const identity = identityOf(node);
    if (!identity) continue;
    const group = out.get(identity);
    if (group) group.push(node);
    else out.set(identity, [node]);
  }
  return out;
}

/**
 * Whether any two entities in the group are declared on a common page.
 *
 * A node's `pages` is capped in the document, so this can miss an overlap that
 * exists past the cap and report nothing. That is the safe direction for a
 * rule at error severity: it says less rather than accusing a correct site.
 */
export function sharesAPage(group: readonly EntityMapNode[]): boolean {
  const seen = new Map<string, string>();
  for (const node of group) {
    for (const page of node.pages) {
      const other = seen.get(page);
      if (other !== undefined && other !== node.key) return true;
      seen.set(page, node.key);
    }
  }
  return false;
}

/**
 * Groups `schema/entity-split-identity` reports: one identity signature, two or
 * more distinct `@id`s, declared together on at least one page. Two different
 * people called John Smith, each with their own `@id` and written about in
 * different places, are not a split.
 */
export function splitIdentityGroups(
  nodes: readonly EntityMapNode[],
): Array<{ nodes: EntityMapNode[]; ids: string[] }> {
  const splits: Array<{ nodes: EntityMapNode[]; ids: string[] }> = [];
  for (const group of groupNodesByIdentity(nodes).values()) {
    if (group.length < 2) continue;
    const ids = [
      ...new Set(group.map((node) => node.id).filter((id): id is string => id !== null)),
    ].sort(compareStrings);
    if (ids.length < 2) continue;
    if (!sharesAPage(group)) continue;
    splits.push({ nodes: [...group].sort((a, b) => pageTotal(b) - pageTotal(a)), ids });
  }
  return splits;
}

/** Named, multi-page, no `@id`, of a type a search engine reconciles site-wide. */
export function isNoIdIdentityNode(node: EntityMapNode): boolean {
  return (
    node.id === null &&
    node.name !== null &&
    pageTotal(node) > 1 &&
    node.types.some((type) => (IDENTITY_TYPES as readonly string[]).includes(type))
  );
}

/** Has an `@id`, nothing references it, declared once, and not a page subject. */
export function isOrphanNode(node: EntityMapNode, referenced: ReadonlySet<string>): boolean {
  return (
    node.id !== null &&
    !referenced.has(node.key) &&
    pageTotal(node) === 1 &&
    // The builder's own verdict on "this describes one page", plus a type list
    // for the shapes it does not catch. Both, because a site can name its
    // WebPage node and defeat the heuristic.
    !node.pageLocal &&
    !node.types.some((type) => PAGE_SUBJECT_TYPES.includes(type))
  );
}

/** Has an `@id` that does not identify the same thing wherever it appears. */
export function isUnstableIdNode(node: EntityMapNode): boolean {
  return node.id !== null && !isStableIdentifier(node.id);
}

/** The `sameAs` profile URLs an entity declares, normalised to a list. */
export function sameAsProfiles(node: EntityMapNode): string[] {
  const sameAs = (node.properties as Record<string, unknown>).sameAs;
  return Array.isArray(sameAs)
    ? sameAs.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : typeof sameAs === "string" && sameAs.length > 0
      ? [sameAs]
      : [];
}

/** A Person needs a `url` or `sameAs` to be more than a string. */
export function isIdentifiedEntity(node: EntityMapNode): boolean {
  const properties = node.properties as Record<string, unknown>;
  const hasUrl = typeof properties.url === "string" && properties.url.length > 0;
  return sameAsProfiles(node).length > 0 || hasUrl;
}

/**
 * The people `schema/entity-authors` judges: those an `author` edge points at,
 * or every Person when nothing carries one (inline author blocks).
 */
export function judgedPeople(map: EntityMap): EntityMapNode[] {
  const people = map.nodes.filter((node) => node.types.includes("Person"));
  const authorKeys = new Set(
    map.edges.filter((edge) => edge.predicate === "author").map((edge) => edge.target),
  );
  return authorKeys.size > 0 ? people.filter((node) => authorKeys.has(node.key)) : people;
}

/** A LocalBusiness declared on so many pages it is repeated rather than referenced. */
export function isLocalBusinessPerPageNode(node: EntityMapNode, pagesCrawled: number): boolean {
  return (
    pagesCrawled >= LOCAL_BUSINESS_MIN_PAGES &&
    node.types.some((type) => isLocalBusinessType(type)) &&
    pageTotal(node) >= pagesCrawled * LOCAL_BUSINESS_PER_PAGE_SHARE
  );
}

/** How the site's publisher references split, heaviest first. Null with none. */
export function publisherWeights(
  map: EntityMap,
): { ranked: Array<[string, number]>; canonical: string; outliers: Array<[string, number]>; looksLikeDrift: boolean } | null {
  const publisherEdges = map.edges.filter((edge) => edge.predicate === "publisher");
  if (publisherEdges.length === 0) return null;
  // Counted by DECLARING WEIGHT, not by distinct target: one publisher named by
  // 200 articles and another by 1 is not a 50/50 disagreement.
  const weight = new Map<string, number>();
  for (const edge of publisherEdges) {
    weight.set(edge.target, (weight.get(edge.target) ?? 0) + edge.occurrences);
  }
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]));
  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  return {
    ranked,
    canonical: ranked[0]![0],
    outliers: ranked.slice(1),
    looksLikeDrift: ranked[0]![1] / total >= PUBLISHER_MAJORITY_SHARE,
  };
}

// ── Problem classes ────────────────────────────────────────────────

/**
 * Every class of node a `schema/entity-*` rule reports. Findings about something
 * ABSENT (`entity-organization-missing`, `entity-website-missing`) have no node
 * to keep and are deliberately not here.
 */
export const ENTITY_PROBLEM_CLASSES = [
  "conflict",
  "dangling",
  "no-id",
  "split-identity",
  "orphan",
  "id-format",
  "sameas-missing",
  "publisher-mismatch",
  "authors",
  "local-business-per-page",
] as const;

export type EntityProblemClass = (typeof ENTITY_PROBLEM_CLASSES)[number];

/**
 * The nodes behind each finding, by class. A node can sit in several classes;
 * a class with no nodes is absent from the result.
 *
 * `conflict` also covers `schema/entity-type-drift`, which reads the `@type`
 * entry of the same `conflicts` array. `publisher-mismatch` names the outlier
 * publishers, or, for a site with one publisher that is not its primary
 * organization, that publisher.
 */
export function entityProblemNodes(
  map: EntityMap,
): Partial<Record<EntityProblemClass, EntityMapNode[]>> {
  const out: Partial<Record<EntityProblemClass, EntityMapNode[]>> = {};
  const add = (cls: EntityProblemClass, node: EntityMapNode | undefined): void => {
    if (node === undefined) return;
    const list = out[cls];
    if (list) list.push(node);
    else out[cls] = [node];
  };

  const referenced = referencedKeys(map);
  const byKey = new Map(map.nodes.map((node) => [node.key, node] as const));
  const pagesCrawled = map.summary.pagesTotal;

  for (const node of map.nodes) {
    if (node.conflicts.length > 0) add("conflict", node);
    if (node.danglingRefs > 0) add("dangling", node);
    if (isNoIdIdentityNode(node)) add("no-id", node);
    if (isOrphanNode(node, referenced)) add("orphan", node);
    if (isUnstableIdNode(node)) add("id-format", node);
    if (isLocalBusinessPerPageNode(node, pagesCrawled)) add("local-business-per-page", node);
  }
  for (const split of splitIdentityGroups(map.nodes)) {
    for (const node of split.nodes) add("split-identity", node);
  }

  const primary = primaryOrganization(map);
  if (primary && sameAsProfiles(primary).length === 0) add("sameas-missing", primary);

  const publishers = publisherWeights(map);
  if (publishers) {
    if (publishers.outliers.length > 0) {
      for (const [key] of publishers.outliers) add("publisher-mismatch", byKey.get(key));
    } else if (primary && publishers.canonical !== primary.key) {
      add("publisher-mismatch", byKey.get(publishers.canonical));
    }
  }

  for (const node of judgedPeople(map)) {
    if (!isIdentifiedEntity(node)) add("authors", node);
  }
  return out;
}
