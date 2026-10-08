import { readdir, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export interface LocalFile {
  absolute: string;
  /** Folder relative to the argument that named it, with a trailing slash, or "". */
  path: string;
  filename: string;
  size: number;
}

/**
 * Expands files and directories into a flat list. Directories are walked
 * recursively and keep their relative folder structure; symbolic links are skipped.
 */
export async function collectFiles(inputs: string | string[]): Promise<LocalFile[]> {
  const results: LocalFile[] = [];
  for (const input of Array.isArray(inputs) ? inputs : [inputs]) {
    const root = resolve(input);
    const info = await stat(root).catch(() => { throw new Error(`No such file or directory: ${input}`) });
    if (info.isFile()) { results.push({ absolute: root, path: "", filename: basename(root), size: info.size }); continue }
    if (!info.isDirectory()) continue;
    const found: LocalFile[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) {
          const folder = relative(root, directory).split(sep).filter(Boolean).join("/");
          found.push({ absolute, path: folder ? `${folder}/` : "", filename: entry.name, size: (await stat(absolute)).size });
        }
      }
    };
    await walk(root);
    results.push(...found.sort((left, right) => left.absolute.localeCompare(right.absolute)));
  }
  return results;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
