// FAQ schema type

import type { AnswerSchema, SchemaType } from "./base";

/**
 * Question schema
 */
export interface QuestionSchema extends SchemaType {
  "@type": "Question";
  name?: string;
  text?: string;
  acceptedAnswer?: AnswerSchema;
  suggestedAnswer?: AnswerSchema | AnswerSchema[];
  answerCount?: number;
  upvoteCount?: number;
  dateCreated?: string;
}

/**
 * FAQPage schema
 */
export interface FAQPageSchema extends SchemaType {
  "@type": "FAQPage";
  mainEntity?: QuestionSchema | QuestionSchema[];
  name?: string;
  description?: string;
}
