export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

/** Flags that never take a value. Anything else consumes the next token unless written as --name=value. */
const BOOLEAN_FLAGS = new Set(["json", "yes", "public", "private", "no-wait", "quiet", "signed", "help", "version", "force", "stdin"]);
const SHORT: Record<string, string> = { y: "yes", h: "help", v: "version", q: "quiet", b: "bucket", f: "folder" };

export function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") { positional.push(...argv.slice(index + 1)); break }
    let name: string | undefined;
    let inline: string | undefined;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      name = eq > 0 ? token.slice(2, eq) : token.slice(2);
      if (eq > 0) inline = token.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(token)) {
      name = SHORT[token.slice(1)] ?? token.slice(1);
    }
    if (name === undefined) {
      if (command === undefined) command = token; else positional.push(token);
      continue;
    }
    if (inline !== undefined) options[name] = inline;
    else if (BOOLEAN_FLAGS.has(name)) options[name] = true;
    else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) { options[name] = next; index += 1 }
      else options[name] = true;
    }
  }
  return { command: command ?? (options.version ? "version" : "help"), positional, options };
}

export function stringOption(options: ParsedArgs["options"], ...names: string[]): string | undefined {
  for (const name of names) {
    const value = options[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function numberOption(options: ParsedArgs["options"], name: string): number | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number`);
  return parsed;
}

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError" }
}
