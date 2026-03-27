import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface KnowledgePattern {
  name: string;
  description: string;
  discovered: string;
  successCount: number;
  lastUsed: string;
  deprecated?: boolean;
  deprecatedReason?: string;
  pattern: {
    identify: string;
    interact: string;
    verify: string;
    failureContext?: string;
  };
}

/** Loads all knowledge patterns from a directory of YAML files. */
export function loadPatterns(
  dir: string,
  options?: { includeDeprecated?: boolean },
): KnowledgePattern[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  const patterns: KnowledgePattern[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(resolve(dir, file), 'utf-8');
      const pattern = parseYaml(content) as KnowledgePattern;
      if (options?.includeDeprecated || !pattern.deprecated) {
        patterns.push(pattern);
      }
    } catch {
      // Skip malformed files
    }
  }

  return patterns;
}

/** Saves a knowledge pattern to a YAML file. */
export function savePattern(dir: string, pattern: KnowledgePattern): void {
  const path = resolve(dir, `${pattern.name}.yml`);
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Increments the success count and updates lastUsed for a pattern. */
export function incrementSuccess(dir: string, name: string): void {
  const path = resolve(dir, `${name}.yml`);
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf-8');
  const pattern = parseYaml(content) as KnowledgePattern;
  pattern.successCount += 1;
  pattern.lastUsed = new Date().toISOString().split('T')[0];
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Marks a pattern as deprecated with a reason. */
export function deprecatePattern(dir: string, name: string, reason: string): void {
  const path = resolve(dir, `${name}.yml`);
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf-8');
  const pattern = parseYaml(content) as KnowledgePattern;
  pattern.deprecated = true;
  pattern.deprecatedReason = reason;
  writeFileSync(path, stringifyYaml(pattern, { lineWidth: 120 }));
}

/** Formats patterns into a text block for inclusion in Claude prompts. */
export function patternsToPromptContext(patterns: KnowledgePattern[]): string {
  if (patterns.length === 0) return '';

  const lines = patterns.map(
    (p) =>
      `- **${p.name}** (used ${p.successCount}x): identify: ${p.pattern.identify} | interact: ${p.pattern.interact} | verify: ${p.pattern.verify}`,
  );

  return `## Known BC Patterns (learned from previous investigations)\n${lines.join('\n')}`;
}
