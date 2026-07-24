// Shared constants used across packages (rules, crawler, parser, audit-engine)

// Resource size check limits
export const RESOURCE_SIZE_LIMITS = {
  IMAGE_WARN_BYTES: 200 * 1024, // 200KB
  IMAGE_ERROR_BYTES: 1 * 1024 * 1024, // 1MB
  CSS_WARN_BYTES: 150 * 1024, // 150KB
  CSS_ERROR_BYTES: 500 * 1024, // 500KB
  JS_WARN_BYTES: 250 * 1024, // 250KB
  JS_ERROR_BYTES: 1 * 1024 * 1024, // 1MB
  MAX_RESOURCES_TO_CHECK: 500, // Limit to prevent resource exhaustion
  CHECK_CONCURRENCY: 5,
  CHECK_TIMEOUT_MS: 10000,
  RETRY_DELAY_MS: 1000,
  MAX_RETRIES: 2,
} as const;

// Script content fetch limits (for security scanning)
export const SCRIPT_FETCH_LIMITS = {
  MAX_SCRIPTS_TO_FETCH: 50,
  MAX_SCRIPT_SIZE_BYTES: 5 * 1024 * 1024, // 5MB
  FETCH_CONCURRENCY: 10,
  FETCH_TIMEOUT_MS: 15000,
  RETRY_DELAY_MS: 1000,
  MAX_RETRIES: 1,
} as const;

// HTTP to HTTPS probe limits
export const HTTP_PROBE_LIMITS = {
  DEFAULT_SAMPLE_SIZE: 20,
  MAX_SAMPLE_SIZE: 100,
  MIN_DELAY_MS: 500,
  /** Concurrent redirect probes against the audited host. */
  PROBE_CONCURRENCY: 5,
  /** Delay between consecutive probes on the SAME worker (politeness). */
  PROBE_STAGGER_MS: 100,
  FOLLOW_TIMEOUT_MS: 10000,
  MAX_REDIRECT_HOPS: 10,
  /**
   * #1252: total wall-clock budget (ms) for the whole http→https probe. Once
   * exceeded, workers stop pulling new sample URLs and the rule reports on the
   * subset already probed — so a tarpitting host can't stretch the probe (which
   * runs INSIDE the rules phase, re-hitting the target) across many minutes.
   */
  PROBE_TOTAL_BUDGET_MS: 20000,
} as const;

// User agent for external checks
export const SQUIRRELSCAN_USER_AGENT = "SquirrelScan/2.0 (+https://squirrelscan.com)";

// Canonical Gemini Flash default (aligned with @squirrelscan/models DEFAULT_MIX.audit) #364/#506.
export const DEFAULT_CLOUD_AUDIT_MODEL = "google/gemini-3.1-flash-lite";

// Leaked secrets scanning window
export const SECRET_CONTEXT_WINDOW_SIZE = 500;

// Shared marker for a cloud audit blocked by a per-website credit cap (#319):
// the /cloud route's 402 typed-envelope `error.code`, the scheduler's skip
// reason, and the dashboard's error check all key off this single string (#562).
export const CLOUD_AUDIT_CAP_EXCEEDED = "CLOUD_AUDIT_CAP_EXCEEDED";

// Googlebot crawl size limits (Feb 2026)
export const GOOGLEBOT_HTML_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const GOOGLEBOT_HTML_WARN_BYTES = 1 * 1024 * 1024; // 1MB
export const GOOGLEBOT_PDF_MAX_BYTES = 60 * 1024 * 1024; // 60MB
export const GOOGLEBOT_PDF_WARN_BYTES = 30 * 1024 * 1024; // 30MB

// Breadth-first crawling constants
export const CRAWL_BREADTH_DEPTH_PENALTY = 1000;
export const CRAWL_BREADTH_MAX_PREFIX_PENALTY = 500;
export const CRAWL_BREADTH_PENALTY_MULTIPLIER = 200;

// Pattern sampling (surface mode)
export const PATTERN_SAMPLED_PENALTY = 2000;

// Link analysis thresholds
export const MIN_INTERNAL_LINKS = 1;

// Grouping key separator (null byte - cannot appear in strings)
export const KEY_SEPARATOR = "\x00";

// Browser impersonation constants
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
export const CHROME_VERSION = "120";
export const CHROME_SEC_CH_UA = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';

// Sitemap coverage rule thresholds
export const SITEMAP_COVERAGE_WARN_PERCENT = 10;
export const SITEMAP_COVERAGE_WARN_COUNT = 5;

// Schema.org LocalBusiness and all subtypes
export const LOCAL_BUSINESS_TYPES = [
  "LocalBusiness",
  "AutomotiveBusiness",
  "AutoBodyShop",
  "AutoDealer",
  "AutoPartsStore",
  "AutoRental",
  "AutoRepair",
  "AutoWash",
  "GasStation",
  "MotorcycleDealer",
  "MotorcycleRepair",
  "EntertainmentBusiness",
  "AdultEntertainment",
  "AmusementPark",
  "ArtGallery",
  "Casino",
  "ComedyClub",
  "MovieTheater",
  "NightClub",
  "FinancialService",
  "AccountingService",
  "AutomatedTeller",
  "BankOrCreditUnion",
  "InsuranceAgency",
  "FoodEstablishment",
  "Bakery",
  "BarOrPub",
  "Brewery",
  "CafeOrCoffeeShop",
  "Distillery",
  "FastFoodRestaurant",
  "IceCreamShop",
  "Restaurant",
  "Winery",
  "HealthAndBeautyBusiness",
  "BeautySalon",
  "DaySpa",
  "HairSalon",
  "HealthClub",
  "NailSalon",
  "TattooParlor",
  "HomeAndConstructionBusiness",
  "Electrician",
  "GeneralContractor",
  "HVACBusiness",
  "HousePainter",
  "Locksmith",
  "MovingCompany",
  "Plumber",
  "RoofingContractor",
  "LegalService",
  "Attorney",
  "Notary",
  "LodgingBusiness",
  "BedAndBreakfast",
  "Campground",
  "Hostel",
  "Hotel",
  "Motel",
  "Resort",
  "MedicalBusiness",
  "CommunityHealth",
  "Dentist",
  "Dermatology",
  "DietNutrition",
  "Emergency",
  "Geriatric",
  "Gynecologic",
  "MedicalClinic",
  "Midwifery",
  "Nursing",
  "Obstetric",
  "Oncologic",
  "Optician",
  "Optometric",
  "Otolaryngologic",
  "Pediatric",
  "Pharmacy",
  "Physician",
  "Physiotherapy",
  "PlasticSurgery",
  "Podiatric",
  "PrimaryCare",
  "Psychiatric",
  "PublicHealth",
  "VeterinaryCare",
  "ProfessionalService",
  "SportsActivityLocation",
  "BowlingAlley",
  "ExerciseGym",
  "GolfCourse",
  "PublicSwimmingPool",
  "SkiResort",
  "SportsClub",
  "StadiumOrArena",
  "TennisComplex",
  "Store",
  "BikeStore",
  "BookStore",
  "ClothingStore",
  "ComputerStore",
  "ConvenienceStore",
  "DepartmentStore",
  "ElectronicsStore",
  "Florist",
  "FurnitureStore",
  "GardenStore",
  "GroceryStore",
  "HardwareStore",
  "HobbyShop",
  "HomeGoodsStore",
  "JewelryStore",
  "LiquorStore",
  "MensClothingStore",
  "MobilePhoneStore",
  "MovieRentalStore",
  "MusicStore",
  "OfficeEquipmentStore",
  "OutletStore",
  "PawnShop",
  "PetStore",
  "ShoeStore",
  "SportingGoodsStore",
  "TireShop",
  "ToyStore",
  "WholesaleStore",
  "WomensClothingStore",
  "ChildCare",
  "DryCleaningOrLaundry",
  "EmergencyService",
  "EmploymentAgency",
  "GovernmentOffice",
  "InternetCafe",
  "Library",
  "RadioStation",
  "RealEstateAgent",
  "RecyclingCenter",
  "SelfStorage",
  "ShoppingCenter",
  "TelevisionStation",
  "TouristInformationCenter",
  "TravelAgency",
] as const;

export type LocalBusinessType = (typeof LOCAL_BUSINESS_TYPES)[number];

// E-E-A-T page URL patterns by type (multilingual).
//
// Trailing anchor `(?:\/|\.html?)?$` lets every slug match a bare path
// (`/about`), a trailing slash (`/about/`), AND a static-file suffix
// (`/about.html`, `/about.htm`) — many CMS / static sites publish these
// pages as `.html`. See issue #121.
export const EEAT_PAGE_PATTERNS = {
  about: [
    /\/about(?:\/|\.html?)?$/i,
    /\/about-us(?:\/|\.html?)?$/i,
    /\/about-me(?:\/|\.html?)?$/i,
    /\/company(?:\/|\.html?)?$/i,
    /\/who-we-are(?:\/|\.html?)?$/i,
    /\/our-story(?:\/|\.html?)?$/i,
    /\/our-team(?:\/|\.html?)?$/i,
    /\/nosotros(?:\/|\.html?)?$/i,
    /\/sobre-nosotros(?:\/|\.html?)?$/i,
    /\/quienes-somos(?:\/|\.html?)?$/i,
    /\/sobre-mi(?:\/|\.html?)?$/i,
    /\/acerca(?:\/|\.html?)?$/i,
    /\/acerca-de(?:\/|\.html?)?$/i,
    /\/empresa(?:\/|\.html?)?$/i,
    /\/a-propos(?:\/|\.html?)?$/i,
    /\/qui-sommes-nous(?:\/|\.html?)?$/i,
    /\/notre-entreprise(?:\/|\.html?)?$/i,
    /\/ueber-uns(?:\/|\.html?)?$/i,
    /\/uber-uns(?:\/|\.html?)?$/i,
    /\/ueber-mich(?:\/|\.html?)?$/i,
    /\/uber-mich(?:\/|\.html?)?$/i,
    /\/unternehmen(?:\/|\.html?)?$/i,
    /\/wir-ueber-uns(?:\/|\.html?)?$/i,
    /\/sobre(?:\/|\.html?)?$/i,
    /\/sobre-nos(?:\/|\.html?)?$/i,
    /\/quem-somos(?:\/|\.html?)?$/i,
    /\/chi-siamo(?:\/|\.html?)?$/i,
    /\/azienda(?:\/|\.html?)?$/i,
    /\/over-ons(?:\/|\.html?)?$/i,
    /\/o-nas(?:\/|\.html?)?$/i,
    /\/o-kompanii(?:\/|\.html?)?$/i,
    /\/kaisha(?:\/|\.html?)?$/i,
    /\/company-info(?:\/|\.html?)?$/i,
  ],
  contact: [
    /\/contact(?:\/|\.html?)?$/i,
    /\/contact-us(?:\/|\.html?)?$/i,
    /\/get-in-touch(?:\/|\.html?)?$/i,
    /\/reach-us(?:\/|\.html?)?$/i,
    /\/contacto(?:\/|\.html?)?$/i,
    /\/contactenos(?:\/|\.html?)?$/i,
    /\/contactanos(?:\/|\.html?)?$/i,
    /\/nous-contacter(?:\/|\.html?)?$/i,
    /\/contactez-nous(?:\/|\.html?)?$/i,
    /\/kontakt(?:\/|\.html?)?$/i,
    /\/contato(?:\/|\.html?)?$/i,
    /\/fale-conosco(?:\/|\.html?)?$/i,
    /\/contatti(?:\/|\.html?)?$/i,
    /\/contattaci(?:\/|\.html?)?$/i,
    /\/neem-contact-op(?:\/|\.html?)?$/i,
    /\/kontakty?(?:\/|\.html?)?$/i,
    /\/otoiawase(?:\/|\.html?)?$/i,
  ],
  privacy: [
    /\/privacy(?:\/|\.html?)?$/i,
    /\/privacy-policy(?:\/|\.html?)?$/i,
    /\/privacy_policy(?:\/|\.html?)?$/i,
    /\/privacy-notice(?:\/|\.html?)?$/i,
    /\/privacy_notice(?:\/|\.html?)?$/i,
    /\/data-privacy(?:\/|\.html?)?$/i,
    /\/privacidad(?:\/|\.html?)?$/i,
    /\/politica-de-privacidad(?:\/|\.html?)?$/i,
    /\/aviso-de-privacidad(?:\/|\.html?)?$/i,
    /\/confidentialite(?:\/|\.html?)?$/i,
    /\/politique-de-confidentialite(?:\/|\.html?)?$/i,
    /\/vie-privee(?:\/|\.html?)?$/i,
    /\/datenschutz(?:\/|\.html?)?$/i,
    /\/datenschutzerklaerung(?:\/|\.html?)?$/i,
    /\/datenschutzhinweise(?:\/|\.html?)?$/i,
    /\/privacidade(?:\/|\.html?)?$/i,
    /\/politica-de-privacidade(?:\/|\.html?)?$/i,
    /\/informativa-privacy(?:\/|\.html?)?$/i,
    /\/riservatezza(?:\/|\.html?)?$/i,
    /\/privacybeleid(?:\/|\.html?)?$/i,
    /\/privacyverklaring(?:\/|\.html?)?$/i,
    /\/polityka-prywatnosci(?:\/|\.html?)?$/i,
    /\/politika-konfidencialnosti(?:\/|\.html?)?$/i,
  ],
  terms: [
    /\/terms(?:\/|\.html?)?$/i,
    /\/terms-of-service(?:\/|\.html?)?$/i,
    /\/terms-of-use(?:\/|\.html?)?$/i,
    /\/terms-and-conditions(?:\/|\.html?)?$/i,
    /\/tos(?:\/|\.html?)?$/i,
    /\/terminos(?:\/|\.html?)?$/i,
    /\/terminos-y-condiciones(?:\/|\.html?)?$/i,
    /\/condiciones-de-uso(?:\/|\.html?)?$/i,
    /\/conditions-generales(?:\/|\.html?)?$/i,
    /\/cgu(?:\/|\.html?)?$/i,
    /\/mentions-legales(?:\/|\.html?)?$/i,
    // `impressum` = German legal imprint (§5 TMG); grouped with terms as the
    // closest legal-compliance bucket since there is no dedicated category.
    /\/agb(?:\/|\.html?)?$/i,
    /\/impressum(?:\/|\.html?)?$/i,
    /\/nutzungsbedingungen(?:\/|\.html?)?$/i,
    /\/allgemeine-geschaeftsbedingungen(?:\/|\.html?)?$/i,
    /\/termos(?:\/|\.html?)?$/i,
    /\/termos-de-uso(?:\/|\.html?)?$/i,
    /\/termos-e-condicoes(?:\/|\.html?)?$/i,
    /\/termini(?:\/|\.html?)?$/i,
    /\/termini-e-condizioni(?:\/|\.html?)?$/i,
    /\/condizioni-duso(?:\/|\.html?)?$/i,
    /\/algemene-voorwaarden(?:\/|\.html?)?$/i,
    /\/regulamin(?:\/|\.html?)?$/i,
  ],
  editorial: [
    /\/editorial-policy(?:\/|\.html?)?$/i,
    /\/editorial-guidelines(?:\/|\.html?)?$/i,
    /\/content-policy(?:\/|\.html?)?$/i,
    /\/fact-check(?:\/|\.html?)?$/i,
    /\/corrections(?:\/|\.html?)?$/i,
    /\/ethics(?:\/|\.html?)?$/i,
    /\/politica-editorial(?:\/|\.html?)?$/i,
    /\/normas-editoriales(?:\/|\.html?)?$/i,
    /\/politique-editoriale(?:\/|\.html?)?$/i,
    /\/charte-editoriale(?:\/|\.html?)?$/i,
    /\/redaktionelle-richtlinien(?:\/|\.html?)?$/i,
    /\/politica-editoriale(?:\/|\.html?)?$/i,
  ],
} as const;

// Scoring constants
export const SCORING_CURVE_EXPONENT = 1.2;
export const SCORE_SCALE = 100;

// Critical crawl penalties
export const PENALTY_NO_ROBOTS_TXT = 0.15;
export const PENALTY_ROBOTS_BLOCKS_ALL = 0.5;
export const PENALTY_NO_SITEMAP = 0.2;

// Rule IDs and check names used in penalty calculations
export const RULE_ID_ROBOTS_TXT = "crawl/robots-txt";
export const RULE_ID_SITEMAP_EXISTS = "crawl/sitemap-exists";
export const CHECK_NAME_ROBOTS_DISALLOW = "robots-txt-disallow";
export const CHECK_NAME_ROBOTS_EXISTS = "robots-txt-exists";
export const CHECK_NAME_SITEMAP_EXISTS = "sitemap-exists";

// Issue density penalty tuning.
//
// The penalty is item-aware for FAILS (#683): each failed check contributes its
// element-level violation count (`items[]`) — capped per (check, page) by
// ISSUE_PENALTY_ITEM_CAP — not just 1 per check. A page with 50 unnamed buttons
// is one fail check carrying 50 items; scoring must feel that volume. The cap
// stops one pathological page from zeroing an entire group/category.
// WARNINGS stay check-level (1 unit per distinct (check, page)) so a single
// many-item warning can't drag a zero-error category to red.
//
// Applied identically to the overall score AND to every group/category bucket
// using that bucket's LOCAL counts, so a group showing "100 errors" can no
// longer read green while overall reads D.
export const ISSUE_PENALTY_THRESHOLD = 10;
export const ISSUE_PENALTY_WARNING_WEIGHT = 1.0;
export const ISSUE_PENALTY_FAIL_WEIGHT = 2.0;
export const ISSUE_PENALTY_SCALE = 3.0;
export const ISSUE_PENALTY_MAX = 0.45;
// Max fail units counted per (checkName, pageUrl) KEY — units from multiple
// checks sharing a key (the smart-audit carried form) are summed, THEN capped.
// So 200 contrast errors on one page count as this, not 200 — one page can't
// zero a group. (#683)
export const ISSUE_PENALTY_ITEM_CAP = 20;

// Default exclude patterns
export const DEFAULT_EXCLUDE_PATTERNS = [
  "/thank-you",
  "/confirmation",
  "/download",
  "/success",
  "/submitted",
];

// Report output constants
export const REPORT_COLLAPSE_THRESHOLD = 3;
export const REPORT_ITEMS_COLLAPSE_THRESHOLD = 5;
export const REPORT_TEXT_WRAP_WIDTH = 70;
export const REPORT_SOURCE_PAGES_PREVIEW = 3;

// The homepage demo report (#663): a real published cloud audit of
// squirrelscan.com, linked from the marketing site's report section, so it must
// never 404. The API refuses to delete this report and a daily scheduler task
// (demo-report:check) verifies it still serves. When refreshing the demo:
// update this ID, then re-capture apps/web/public/images/html-report-screenshot.webp
// from the same report so the screenshot and link stay in sync.
export const DEMO_REPORT_ID = "01KWKSVT79R6SZDQE7K6WWZCFY";
export const DEMO_REPORT_URL = `https://reports.squirrelscan.com/${DEMO_REPORT_ID}`;

// Org logo upload (#807): allowed image types + max size, shared by the API
// upload validation and the dashboard upload UI so they can't drift.
export const ORG_LOGO_MAX_BYTES = 1024 * 1024; // 1MB
export const ORG_LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type OrgLogoContentType = (typeof ORG_LOGO_CONTENT_TYPES)[number];

// Public rule/category counts for marketing and doc copy that can't read the
// live catalog (MDX, plugin manifests, skill files, MCP tool descriptions).
// PUBLIC_RULE_COUNT_FLOOR is deliberately rounded DOWN from the live total
// (apps/api/src/generated/rule-catalog.ts totalRules, currently 262) so copy
// doesn't need a bump on every rule add/remove; PUBLIC_CATEGORY_COUNT tracks
// exactly since categories change far less often. The widened #483 drift
// guard (apps/api/tests/routes/rule-count-consistency.test.ts) fails the
// build if the floor ever exceeds the live count. Bump both by hand when the
// live count moves meaningfully past the floor. #1019 #986 #981
export const PUBLIC_RULE_COUNT_FLOOR = 260;
export const PUBLIC_CATEGORY_COUNT = 21;

// Hosted MCP (#113). These appear in the well-known manifests, the /add/<agent>
// install redirects, and every /for/<tool> setup snippet — a stale copy in a
// docs snippet is a user-facing bug (they paste it into their agent config),
// so all of them interpolate from here rather than inlining the literal.
export const MCP_BASE_URL = "https://mcp.squirrelscan.com";
export const MCP_SERVER_URL = `${MCP_BASE_URL}/mcp`;

// Feedback single sink (#1119): every interface (website, dashboard, CLI,
// API, MCP) writes the same `feedback` table, so the classification
// vocabularies live here where the API, CLI, and admin can all reach them.
// Servers clamp-not-reject: values outside these lists become null with the
// raw value stashed in metadata, never a 400.
export const FEEDBACK_CATEGORIES = [
  "bug_report",
  "feature_request",
  "what_worked",
  "confusing",
  "missing_data",
  "tool_ergonomics",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_SOURCES = ["website", "dashboard", "cli", "api", "mcp"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];
