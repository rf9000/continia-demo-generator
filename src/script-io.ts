// src/script-io.ts
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ScriptFile } from './script-types.js';
import { info } from './log.js';

/**
 * Computes a hash of the original spec's steps array.
 * Used to detect when the spec has changed and re-investigation is needed.
 */
export function computeSpecHash(steps: unknown[]): string {
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

/** Writes a ScriptFile to disk as YAML. */
export function writeScript(script: ScriptFile, path: string): void {
  writeFileSync(path, stringifyYaml(script, { lineWidth: 120 }));
  info(`Script written to: ${path}`);
}

/** Reads a ScriptFile from disk. */
export function readScript(path: string): ScriptFile {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as ScriptFile;
}

/**
 * Checks whether an existing .script.yml is still valid by comparing
 * its specHash against the current original spec.
 */
export function isScriptValid(specPath: string, scriptPath: string): boolean {
  try {
    const specContent = parseYaml(readFileSync(specPath, 'utf-8')) as { steps: unknown[] };
    const script = readScript(scriptPath);
    if (!script.specHash) return false;
    const currentHash = computeSpecHash(specContent.steps);
    return currentHash === script.specHash;
  } catch {
    return false;
  }
}
