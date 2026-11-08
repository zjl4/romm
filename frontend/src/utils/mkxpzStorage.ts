import type { PlayerSaveFile } from "@/utils/saveSync";

// The core mounts the browser's origin private file system here, so a path
// below it is the same file the page reads through navigator.storage.
export const MKXPZ_MOUNT = "/nostalgist/persistent";

const ROOT = "mkxpz";
const GAMES = "games";
// The core files a game's saves under `<save directory>/mkxp-z/Saves/<title>`.
const CORE_SAVES = ["mkxp-z", "Saves"];
// The marker a fully written game archive leaves beside itself.
const COMPLETE_SUFFIX = ".done";

export interface MkxpzPaths {
  saveDirectory: string;
  stateDirectory: string;
  systemDirectory: string;
  game: string;
}

/** Names one user's copy of one game, so accounts sharing a browser keep apart. */
export function mkxpzProfile(romId: number, userId: number): string {
  return `${romId}-${userId}`;
}

/** Where the core reads and writes, as paths below `MKXPZ_MOUNT`. */
export function mkxpzPaths(profile: string, gameFile: string): MkxpzPaths {
  const root = `${MKXPZ_MOUNT}/${ROOT}`;
  return {
    saveDirectory: `${root}/saves/${profile}`,
    stateDirectory: `${root}/states/${profile}`,
    systemDirectory: `${root}/system`,
    game: `${root}/${GAMES}/${gameFile}`,
  };
}

/** The OPFS folders `mkxpzPaths` names, created so the core can write in them. */
export async function ensureMkxpzDirectories(paths: MkxpzPaths): Promise<void> {
  for (const path of [
    paths.saveDirectory,
    paths.stateDirectory,
    paths.systemDirectory,
  ]) {
    await directoryAt(segmentsOf(path), true);
  }
}

function segmentsOf(path: string): string[] {
  return path
    .slice(MKXPZ_MOUNT.length)
    .split("/")
    .filter((segment) => segment.length > 0);
}

async function directoryAt(
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = await navigator.storage.getDirectory();
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

async function directoryOrNull(
  segments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await directoryAt(segments, false);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function exists(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * The archive name a game's files cache under: a new name whenever they change.
 *
 * Args:
 *   romId: The ROM the files belong to.
 *   files: Each file's id, size and modification time.
 */
export async function mkxpzGameFile(
  romId: number,
  files: {
    id: number;
    file_size_bytes: number;
    last_modified: string | null;
  }[],
): Promise<string> {
  const signature = files
    .map((f) => `${f.id}:${f.file_size_bytes}:${f.last_modified ?? ""}`)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(signature),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${romId}-${hex}.mkxpz`;
}

/**
 * Download `url` into the games folder as `gameFile`, unless it is already there.
 *
 * Older archives of the same ROM are removed, since their files have changed.
 */
export async function cacheMkxpzGame(
  romId: number,
  gameFile: string,
  url: string,
): Promise<void> {
  const games = await directoryAt([ROOT, GAMES], true);
  const marker = `${gameFile}${COMPLETE_SUFFIX}`;

  if (!(await exists(games, marker))) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok || !response.body) {
      throw new Error(`Game download failed: ${response.status}`);
    }
    const handle = await games.getFileHandle(gameFile, { create: true });
    await response.body.pipeTo(await handle.createWritable());
    await games.getFileHandle(marker, { create: true });
  }

  const stale: string[] = [];
  for await (const name of games.keys()) {
    if (name.startsWith(`${romId}-`) && !name.startsWith(gameFile)) {
      stale.push(name);
    }
  }
  await Promise.all(stale.map((name) => games.removeEntry(name)));
}

// A slot names the title folder and the file, as only one of each level exists.
function splitSlot(slot: string): [string, string] | null {
  const parts = slot.split("/");
  if (parts.length !== 2) return null;
  const [title, name] = parts as [string, string];
  if (!title || !name || title === ".." || name === "..") return null;
  return [title, name];
}

function savesSegments(profile: string): string[] {
  return [...segmentsOf(mkxpzPaths(profile, "").saveDirectory), ...CORE_SAVES];
}

/** Every file the core holds in a game's save folder, one slot per file. */
export async function readMkxpzSaves(
  profile: string,
): Promise<PlayerSaveFile[]> {
  const root = await directoryOrNull(savesSegments(profile));
  if (!root) return [];

  const saves: PlayerSaveFile[] = [];
  for await (const [title, titleHandle] of root.entries()) {
    if (titleHandle.kind !== "directory") continue;
    for await (const [name, fileHandle] of titleHandle.entries()) {
      if (fileHandle.kind !== "file") continue;
      try {
        const file = await fileHandle.getFile();
        saves.push({
          slot: `${title}/${name}`,
          fileName: name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          updatedAt: file.lastModified,
        });
      } catch (error) {
        // The core may hold the file open mid-write; the next read catches it.
        console.warn(`[mkxp-z] Skipped unreadable save ${name}`, error);
      }
    }
  }
  return saves;
}

/** Put `saves` where the core looks for them when it next starts the game. */
export async function writeMkxpzSaves(
  profile: string,
  saves: { slot: string; bytes: Uint8Array }[],
): Promise<void> {
  for (const save of saves) {
    const parts = splitSlot(save.slot);
    if (!parts) continue;
    const [title, name] = parts;
    const directory = await directoryAt(
      [...savesSegments(profile), title],
      true,
    );
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(save.bytes as BlobPart);
    await writable.close();
  }
}

/** Remove the save files in `slots` from the core's save folder. */
export async function deleteMkxpzSaves(
  profile: string,
  slots: string[],
): Promise<void> {
  for (const slot of slots) {
    const parts = splitSlot(slot);
    if (!parts) continue;
    const directory = await directoryOrNull([
      ...savesSegments(profile),
      parts[0],
    ]);
    await directory?.removeEntry(parts[1]).catch(() => undefined);
  }
}
