import { execSync } from 'child_process';
import { info, debug } from './log.js';

export interface EnvInfo {
  id: string;
  name: string;
  profileId: string;
  status: string;
}

/**
 * Gets info about a DemoPortal environment via `continia env get`.
 */
export function getEnvInfo(envId: string): EnvInfo {
  const output = execSync(`continia env get ${envId} --json`, {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const data = JSON.parse(output);
  return {
    id: data.id ?? envId,
    name: data.name ?? '',
    profileId: data.profileId ?? data.profile ?? '',
    status: data.status ?? 'Unknown',
  };
}

/**
 * Deletes a DemoPortal environment.
 */
export function deleteEnv(envId: string): void {
  info(`Deleting environment ${envId}...`);
  execSync(`continia env delete ${envId}`, {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  info(`Environment ${envId} deleted`);
}

/**
 * Creates a new DemoPortal environment and returns its ID.
 */
export function createEnv(name: string, profileId: string): string {
  info(`Creating environment "${name}" (profile: ${profileId})...`);
  const output = execSync(`continia env create --name "${name}" --profile "${profileId}" --json`, {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const data = JSON.parse(output);
  const newId = data.id;
  if (!newId) {
    throw new Error(`Failed to parse new environment ID from: ${output}`);
  }
  info(`Created environment ${newId}`);
  return newId;
}

/**
 * Polls until the environment reaches "Running" status.
 * Checks every 10 seconds, times out after maxWaitMs (default 5 minutes).
 */
export async function waitForEnvRunning(envId: string, maxWaitMs = 300_000): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const envInfo = getEnvInfo(envId);
    debug(`Environment ${envId} status: ${envInfo.status}`);

    if (envInfo.status === 'Running') {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      info(`Environment ${envId} running (took ${elapsed}s)`);
      return;
    }

    if (envInfo.status === 'Error' || envInfo.status === 'Failed') {
      throw new Error(`Environment ${envId} entered ${envInfo.status} state`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for environment ${envId} to reach Running (waited ${maxWaitMs / 1000}s)`,
  );
}

/**
 * Resets the BC environment: deletes the old one, creates a fresh one with
 * the same profile, and waits until it's running.
 *
 * Returns the new environment ID and the new BC start address.
 */
export async function resetEnvironment(
  currentEnvId: string,
  bcStartAddress: string,
): Promise<{ envId: string; bcStartAddress: string }> {
  // Get current env info for profile ID
  const envInfo = getEnvInfo(currentEnvId);
  const envName = envInfo.name || `demo-${Date.now()}`;
  const profileId = envInfo.profileId;

  if (!profileId) {
    throw new Error(`Cannot determine profile ID for environment ${currentEnvId}`);
  }

  // Delete old environment
  deleteEnv(currentEnvId);

  // Create fresh environment
  const newEnvId = createEnv(envName, profileId);

  // Wait for it to be ready
  await waitForEnvRunning(newEnvId);

  // Build new BC URL — replace old envId in the URL with new one
  const newUrl = bcStartAddress.replace(currentEnvId, newEnvId);

  return { envId: newEnvId, bcStartAddress: newUrl };
}

/**
 * Extracts the environment ID from a DemoPortal BC URL.
 * DemoPortal URLs look like: https://demoportaldev.continiaonline.com/<envId>/
 */
export function extractEnvId(bcUrl: string): string | null {
  try {
    const url = new URL(bcUrl);
    // The envId is the first path segment
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[0] ?? null;
  } catch {
    return null;
  }
}
