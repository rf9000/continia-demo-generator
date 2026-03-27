import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolve, parse as parsePath } from 'path';
import { info, debug } from './log.js';
import type { StepDiscovery, EnrichedSpec } from './types.js';

/**
 * Computes a hash of the original spec's steps to detect when the spec
 * has changed and re-investigation is needed.
 */
export function computeDiscoveryHash(steps: unknown[]): string {
  const content = JSON.stringify(
    steps.map((s) => {
      const step = s as Record<string, unknown>;
      return {
        type: step.type,
        target: step.target,
        caption: step.caption,
        row: step.row,
        value: step.value,
        assistEdit: step.assistEdit,
      };
    }),
  );
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Merges per-step discovery metadata into the original spec, producing
 * an enriched spec with `discovery` blocks on each step.
 */
export function enrichSpec(originalSpecPath: string, discoveries: StepDiscovery[]): EnrichedSpec {
  const content = readFileSync(originalSpecPath, 'utf-8');
  const spec = parseYaml(content) as EnrichedSpec;

  // Merge discovery into each step
  for (let i = 0; i < spec.steps.length; i++) {
    const discovery = discoveries[i];
    if (discovery && Object.keys(discovery).length > 0) {
      spec.steps[i].discovery = discovery;
    }
  }

  // Compute hash from original steps (before enrichment)
  const originalSteps = parseYaml(content).steps as unknown[];
  spec.discoveryHash = computeDiscoveryHash(originalSteps);

  return spec;
}

/**
 * Writes an enriched spec to `<name>.enriched.yml` in the output directory.
 * Returns the path to the written file.
 */
export function writeEnrichedSpec(
  originalSpecPath: string,
  discoveries: StepDiscovery[],
  outputDir: string,
): string {
  const enriched = enrichSpec(originalSpecPath, discoveries);
  const specName = parsePath(originalSpecPath).name;
  const outputPath = resolve(outputDir, `${specName}.enriched.yml`);

  writeFileSync(outputPath, stringifyYaml(enriched, { lineWidth: 120 }));
  info(`Enriched spec written to: ${outputPath}`);

  // Log summary
  const total = enriched.steps.length;
  const enrichedCount = enriched.steps.filter((s) => s.discovery).length;
  const foundCount = enriched.steps.filter((s) => s.discovery?.fieldFound !== false).length;
  info(`  ${enrichedCount}/${total} steps enriched, ${foundCount} fields found`);

  return outputPath;
}

/**
 * Checks whether an existing enriched spec is still valid by comparing
 * its discoveryHash against the current original spec.
 * Returns true if the enriched spec is up to date.
 */
export function isEnrichedSpecValid(originalSpecPath: string, enrichedSpecPath: string): boolean {
  try {
    const original = parseYaml(readFileSync(originalSpecPath, 'utf-8'));
    const enriched = parseYaml(readFileSync(enrichedSpecPath, 'utf-8')) as EnrichedSpec;

    if (!enriched.discoveryHash) return false;

    const currentHash = computeDiscoveryHash(original.steps);
    const valid = currentHash === enriched.discoveryHash;

    if (!valid) {
      debug(`Discovery hash mismatch: ${currentHash} != ${enriched.discoveryHash}`);
    }

    return valid;
  } catch {
    return false;
  }
}

/**
 * Checks if all steps in a spec have discovery blocks.
 */
export function isFullyEnriched(specPath: string): boolean {
  try {
    const spec = parseYaml(readFileSync(specPath, 'utf-8')) as EnrichedSpec;
    return spec.steps.every((s) => s.discovery != null);
  } catch {
    return false;
  }
}

/**
 * Reads the discoveries array from an enriched spec file.
 */
export function readDiscoveries(enrichedSpecPath: string): StepDiscovery[] {
  const spec = parseYaml(readFileSync(enrichedSpecPath, 'utf-8')) as EnrichedSpec;
  return spec.steps.map((s) => s.discovery ?? {});
}
