// src/script-types.ts

/** A prep action the vision model says to do before the main action. */
export interface PrepAction {
  action: 'scroll' | 'click' | 'wait';
  coordinates?: { x: number; y: number };
  direction?: 'up' | 'down' | 'left' | 'right';
  px?: number;
  ms?: number;
  reason?: string;
}

/** Result from the vision model's locate call. */
export interface LocateResult {
  element: string;
  coordinates: { x: number; y: number };
  confidence: number;
  prep: PrepAction[];
  observation: string;
}

/** Result from the vision model's verify call. */
export interface VerifyResult {
  success: boolean;
  beforePage?: string;
  afterPage?: string;
  observation: string;
  newState?: string;
}

/** The original YAML step, preserved in the script for debugging. */
export interface ScriptStepSource {
  type: string;
  caption?: string;
  field?: string;
  value?: string;
  row?: number | string;
  assistEdit?: boolean;
}

/** One step in the coordinate script. */
export interface ScriptStep {
  index: number;
  source: ScriptStepSource;
  action: 'click' | 'click-then-type' | 'double-click';
  coordinates: { x: number; y: number };
  value?: string;
  confidence: number;
  prep: PrepAction[];
  verification: VerifyResult;
  context?: string;
  screenshot: string;
}

/** One entry in the step timing metadata. */
export interface StepTimingEntry {
  stepIndex: number;
  startMs: number;
  endMs: number;
}

/** Timing metadata produced by the script player for the composer/subtitle modules. */
export interface StepTimingMetadata {
  trimStartMs: number;
  steps: StepTimingEntry[];
}

/** The top-level .script.yml file. */
export interface ScriptFile {
  specHash: string;
  model: string;
  investigatedAt: string;
  viewportSize: { width: number; height: number };
  steps: ScriptStep[];
}
