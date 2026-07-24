// Types for Document-based extractors
// These extractors receive a pre-parsed Document instead of raw HTML

import type { Document } from "linkedom";

import type {
  ContentAnalysis,
  HeadingHierarchy,
  ImageData,
  LinkData,
  MetaData,
  OpenGraphData,
  SchemaData,
  TwitterData,
} from "@squirrelscan/core-contracts";

export type LinkPosition =
  | "header"
  | "footer"
  | "nav"
  | "content"
  | "sidebar"
  | "unknown";

// Re-export types for convenience
export type {
  ContentAnalysis,
  HeadingHierarchy,
  ImageData,
  LinkData,
  MetaData,
  OpenGraphData,
  SchemaData,
  TwitterData,
};

// Extended link data with position
export interface ExtractedLink {
  href: string;
  text: string;
  isInternal: boolean;
  position: LinkPosition;
  rel?: string[];
  isNofollow: boolean;
}

// Extended image data
export interface ExtractedImage {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
  isLazyLoaded: boolean;
  inFigure: boolean;
}

// All extracted data from a page
export interface ExtractedPageData {
  meta: MetaData;
  h1: { count: number; texts: string[] };
  og: OpenGraphData;
  twitter: TwitterData;
  links: ExtractedLink[];
  images: ExtractedImage[];
  schema: SchemaData;
  headings: HeadingHierarchy;
  content: ContentAnalysis;
}

// Extractor function type
export type Extractor<T> = (doc: Document, baseUrl: string) => T;
