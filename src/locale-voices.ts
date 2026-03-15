export interface VoiceConfig {
  voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  speed: number;
}

const LOCALE_VOICE_MAP: Record<string, VoiceConfig> = {
  'da-DK': { voice: 'nova', speed: 0.95 },
  'en-US': { voice: 'nova', speed: 1.0 },
  'en-GB': { voice: 'nova', speed: 1.0 },
  'de-DE': { voice: 'nova', speed: 0.95 },
  'nl-NL': { voice: 'nova', speed: 0.95 },
  'no-NO': { voice: 'nova', speed: 0.95 },
  'sv-SE': { voice: 'nova', speed: 0.95 },
};

const DEFAULT_VOICE: VoiceConfig = { voice: 'nova', speed: 1.0 };

export function getVoiceForLocale(locale?: string): VoiceConfig {
  if (!locale) return DEFAULT_VOICE;
  return LOCALE_VOICE_MAP[locale] ?? DEFAULT_VOICE;
}
