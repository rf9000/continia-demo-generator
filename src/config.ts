import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

export interface DemoConfig {
  bcStartAddress: string;
  bcAuth: 'Windows' | 'AAD' | 'UserPassword';
  bcUsernameKey?: string;
  bcPasswordKey?: string;
  outputDir: string;
  headed: boolean;
  anthropicApiKey?: string;
  visionModel: string;
}

export function loadConfig(overrides?: Partial<DemoConfig>): DemoConfig {
  return {
    bcStartAddress:
      overrides?.bcStartAddress ?? process.env['BC_START_ADDRESS'] ?? 'http://localhost:8080/bc/',
    bcAuth: (overrides?.bcAuth ?? process.env['BC_AUTH'] ?? 'Windows') as DemoConfig['bcAuth'],
    bcUsernameKey: overrides?.bcUsernameKey ?? process.env['BC_USERNAME_KEY'],
    bcPasswordKey: overrides?.bcPasswordKey ?? process.env['BC_PASSWORD_KEY'],
    outputDir: overrides?.outputDir ?? process.env['OUTPUT_DIR'] ?? './output',
    headed: overrides?.headed ?? true,
    anthropicApiKey: overrides?.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'],
    visionModel: overrides?.visionModel ?? 'claude-sonnet-4-6-20250514',
  };
}
