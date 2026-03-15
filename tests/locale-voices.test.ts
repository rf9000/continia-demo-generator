import { describe, test, expect } from 'vitest';
import { getVoiceForLocale } from '../src/locale-voices.js';

describe('getVoiceForLocale', () => {
  test('da-DK returns nova at 0.95 speed', () => {
    const config = getVoiceForLocale('da-DK');
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(0.95);
  });

  test('en-US returns nova at 1.0 speed', () => {
    const config = getVoiceForLocale('en-US');
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(1.0);
  });

  test('de-DE returns nova at 0.95 speed', () => {
    const config = getVoiceForLocale('de-DE');
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(0.95);
  });

  test('unknown locale falls back to default', () => {
    const config = getVoiceForLocale('zh-CN');
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(1.0);
  });

  test('undefined input returns default', () => {
    const config = getVoiceForLocale(undefined);
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(1.0);
  });

  test('empty string returns default', () => {
    const config = getVoiceForLocale('');
    expect(config.voice).toBe('nova');
    expect(config.speed).toBe(1.0);
  });
});
