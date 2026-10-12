import { execFile } from "node:child_process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { OCMessageWithParts, OCPart } from "./types.js";

const exec = promisify(execFile);

/** Include both the legacy content and the current SDK's patch contracts. */
export interface SessionFileDiff {
  file: string;
  path: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  patch: string;
  status: "added" | "modified" | "deleted";
}

export function touchedFiles(parts: readonly OCPart[]): string[] {
  return [...new Set(parts.flatMap((part) =>
    part.type === "tool" && ["write", "edit", "multiedit"].includes(part.tool) &&
    part.state.status === "completed" && typeof part.state.input.filePath === "string"
      ? [part.state.input.filePath] : []))];
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd: directory, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

/** A removed file may be absent, but neither traversal nor symlinks may escape. */
async function confinedFile(directory: string, path: string): Promise<string | undefined> {
  const root = await realpath(directory);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  let ancestor = absolute;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      const actualRel = relative(root, actual);
      if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) return undefined;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      ancestor = resolve(ancestor, "..");
    }
  }
  try {
    if (!(await lstat(absolute)).isFile()) return undefined;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return absolute;
}

export async function sessionDiff(directory: string, messages: readonly OCMessageWithParts[]): Promise<SessionFileDiff[]> {
  let gitRoot: string | undefined;
  try {
    gitRoot = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "number")) throw error;
  }
  const diffs: SessionFileDiff[] = [];
  const seen = new Set<string>();
  for (const path of touchedFiles(messages.flatMap((message) => message.parts))) {
    const absolute = await confinedFile(directory, path);
    if (absolute === undefined || seen.has(absolute)) continue;
    seen.add(absolute);
    const file = relative(await realpath(directory), absolute).split(sep).join("/");
    let after = "";
    let exists = true;
    try {
      after = await readFile(absolute, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      exists = false;
    }
    let before = "";
    let tracked = false;
    let patch = "";
    let additions = 0;
    let deletions = 0;
    if (gitRoot !== undefined) {
      const gitPath = relative(gitRoot, absolute).split(sep).join("/");
      try {
        before = await git(gitRoot, ["show", `HEAD:${gitPath}`]);
        tracked = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && typeof error.code === "number")) throw error;
      }
      if (tracked) {
        const literal = `:(literal)${gitPath}`;
        const numstat = await git(gitRoot, ["diff", "HEAD", "--numstat", "--", literal]);
        const counts = numstat.split("\t");
        additions = Number(counts[0]) || 0;
        deletions = Number(counts[1]) || 0;
        patch = await git(gitRoot, ["diff", "HEAD", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", literal]);
      } else if (exists) {
        // --no-index returns 1 when differences exist; that is its success contract.
        try {
          patch = await git(gitRoot, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", gitPath]);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string")) throw error;
          patch = error.stdout;
        }
        additions = after === "" ? 0 : after.split("\n").length - (after.endsWith("\n") ? 1 : 0);
      }
    }
    diffs.push({ file, path: file, before, after, additions, deletions, patch,
      status: !exists ? "deleted" : tracked ? "modified" : "added" });
  }
  return diffs;
}
