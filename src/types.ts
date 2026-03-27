/**
 * Types for the investigative pre-run discovery system.
 * These are used to enrich YAML specs with metadata discovered during
 * a headless dry run, so the real recording can navigate confidently.
 */

// --- Page Type ---

export type PageType = 'Card' | 'List' | 'Document' | 'Worksheet' | 'Dialog';

// --- Access Path ---

export type AccessPathStep =
  | { expandFastTab: string }
  | { clickShowMore: true }
  | { scroll: { direction: 'up' | 'down' | 'left' | 'right'; px: number } };

// --- Menu Path ---

export interface MenuPath {
  tab: string | null;
  group: string | null;
}

// --- Per-Step Discovery ---

export interface StepDiscovery {
  pageType?: PageType;
  selector?: string;
  strategy?: string;
  accessPath?: AccessPathStep[];
  menuPath?: MenuPath;
  matchedRowIndex?: number;
  matchedRowText?: string;
  inputMethod?: 'directFill' | 'dnPlayRecording';
  fieldFound?: boolean;
}

// --- Enriched Spec ---

export interface EnrichedStep {
  type: string;
  target?: Array<{ page?: string; field?: string }>;
  caption?: string;
  row?: number | string;
  value?: string;
  description?: string;
  assistEdit?: boolean;
  discovery?: StepDiscovery;
}

export interface EnrichedSpec {
  name?: string;
  description?: string;
  start?: {
    profile?: string;
    page?: string;
    pageId?: number;
  };
  timeout?: number;
  steps: EnrichedStep[];
  demo?: Record<string, unknown>;
  /** Hash of the original spec's steps to detect when re-investigation is needed */
  discoveryHash?: string;
}
