// Schema type exports

export type {
  SchemaType,
  ParsedSchema,
  ImageObjectSchema,
  PostalAddressSchema,
  ContactPointSchema,
  AnswerSchema,
  SchemaValidationIssue,
} from "./base";

export type { PersonSchema } from "./person";

export type { OrganizationSchema, LocalBusinessSchema } from "./organization";

export type { ArticleSchema } from "./article";

export type {
  ProductSchema,
  BrandSchema,
  OfferSchema,
  AggregateRatingSchema,
  ReviewSchema,
} from "./product";

export type { FAQPageSchema, QuestionSchema } from "./faq";

export type { EventSchema, PlaceSchema } from "./event";

export type {
  RecipeSchema,
  NutritionInformationSchema,
  HowToStepSchema,
} from "./recipe";

export type { VideoObjectSchema, AudioObjectSchema, ClipSchema } from "./video";

export type {
  BreadcrumbListSchema,
  BreadcrumbListItemSchema,
} from "./breadcrumb";

export type {
  WebSiteSchema,
  WebPageSchema,
  CollectionPageSchema,
  ProfilePageSchema,
  SearchResultsPageSchema,
  AboutPageSchema,
  ContactPageSchema,
  SearchActionSchema,
} from "./website";
