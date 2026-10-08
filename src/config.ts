import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  apiKey?: string;
  apiUrl?: string;
  cdnUrl?: string;
  /** Default bucket ID, slug, or name for `upload` and `ls`. */
  bucket?: string;
}

/** `$STEADYLINK_CONFIG`, else `%APPDATA%\steadylink\config.json` on Windows, else `$XDG_CONFIG_HOME/steadylink/config.json`. */
export function configPath(env: Record<string, string | undefined>, platform: string = process.platform): string {
  if (env.STEADYLINK_CONFIG) return env.STEADYLINK_CONFIG;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "steadylink", "config.json");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "steadylink", "config.json");
}

export async function readConfig(path: string): Promise<CliConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as CliConfig : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
}

/** Writes the config with owner-only permissions where the OS supports them. */
export async function writeConfig(path: string, config: CliConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function deleteConfig(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
