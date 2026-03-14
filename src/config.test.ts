import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear relevant env vars so .env file doesn't interfere
    delete process.env['BC_START_ADDRESS'];
    delete process.env['BC_AUTH'];
    delete process.env['BC_USERNAME_KEY'];
    delete process.env['BC_PASSWORD_KEY'];
    delete process.env['OUTPUT_DIR'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns defaults when no env vars or overrides', () => {
    const config = loadConfig();
    expect(config.bcStartAddress).toBe('http://localhost:8080/bc/');
    expect(config.bcAuth).toBe('Windows');
    expect(config.outputDir).toBe('./output');
    expect(config.headed).toBe(true);
    expect(config.bcUsernameKey).toBeUndefined();
    expect(config.bcPasswordKey).toBeUndefined();
  });

  test('reads from environment variables', () => {
    process.env['BC_START_ADDRESS'] = 'http://mybc:7049/bc/';
    process.env['BC_AUTH'] = 'UserPassword';
    process.env['BC_USERNAME_KEY'] = 'MY_USER';
    process.env['BC_PASSWORD_KEY'] = 'MY_PASS';
    process.env['OUTPUT_DIR'] = './videos';

    const config = loadConfig();
    expect(config.bcStartAddress).toBe('http://mybc:7049/bc/');
    expect(config.bcAuth).toBe('UserPassword');
    expect(config.bcUsernameKey).toBe('MY_USER');
    expect(config.bcPasswordKey).toBe('MY_PASS');
    expect(config.outputDir).toBe('./videos');
  });

  test('overrides take precedence over env vars', () => {
    process.env['BC_START_ADDRESS'] = 'http://from-env/bc/';
    process.env['BC_AUTH'] = 'Windows';

    const config = loadConfig({
      bcStartAddress: 'http://from-override/bc/',
      bcAuth: 'AAD',
    });

    expect(config.bcStartAddress).toBe('http://from-override/bc/');
    expect(config.bcAuth).toBe('AAD');
  });

  test('partial overrides merge with env and defaults', () => {
    process.env['BC_AUTH'] = 'UserPassword';

    const config = loadConfig({
      bcStartAddress: 'http://custom/bc/',
    });

    expect(config.bcStartAddress).toBe('http://custom/bc/');
    expect(config.bcAuth).toBe('UserPassword'); // from env
    expect(config.outputDir).toBe('./output');   // from default
  });
});
