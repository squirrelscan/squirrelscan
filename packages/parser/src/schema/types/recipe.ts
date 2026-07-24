// Recipe schema type

import type { ImageObjectSchema, SchemaType } from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";
import type { AggregateRatingSchema, ReviewSchema } from "./product";

/**
 * NutritionInformation schema
 */
export interface NutritionInformationSchema extends SchemaType {
  "@type": "NutritionInformation";
  calories?: string;
  carbohydrateContent?: string;
  cholesterolContent?: string;
  fatContent?: string;
  fiberContent?: string;
  proteinContent?: string;
  saturatedFatContent?: string;
  servingSize?: string;
  sodiumContent?: string;
  sugarContent?: string;
  transFatContent?: string;
  unsaturatedFatContent?: string;
}

/**
 * HowToStep schema (shared with HowTo)
 */
export interface HowToStepSchema extends SchemaType {
  "@type": "HowToStep";
  text?: string;
  name?: string;
  url?: string;
  image?: string | ImageObjectSchema;
  position?: number;
}

/**
 * Recipe schema
 */
export interface RecipeSchema extends SchemaType {
  "@type": "Recipe";
  name?: string;
  description?: string;
  image?: string | ImageObjectSchema | (string | ImageObjectSchema)[];
  author?: PersonSchema | OrganizationSchema | string;
  datePublished?: string;
  prepTime?: string; // ISO 8601 duration
  cookTime?: string;
  totalTime?: string;
  recipeYield?: string | number;
  recipeIngredient?: string[];
  recipeInstructions?: string | HowToStepSchema | HowToStepSchema[];
  recipeCategory?: string | string[];
  recipeCuisine?: string | string[];
  keywords?: string;
  nutrition?: NutritionInformationSchema;
  aggregateRating?: AggregateRatingSchema;
  review?: ReviewSchema | ReviewSchema[];
  video?: VideoObjectSchemaRef;
  suitableForDiet?: string | string[];
}

// Forward reference
interface VideoObjectSchemaRef extends SchemaType {
  "@type": "VideoObject";
  name?: string;
  contentUrl?: string;
  thumbnailUrl?: string;
}
