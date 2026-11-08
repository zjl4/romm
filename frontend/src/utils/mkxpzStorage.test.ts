import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheMkxpzGame,
  deleteMkxpzSaves,
  ensureMkxpzDirectories,
  MKXPZ_MOUNT,
  mkxpzGameFile,
  mkxpzPaths,
  readMkxpzSaves,
  writeMkxpzSaves,
} from "./mkxpzStorage";

// An in-memory origin private file system, as much of it as the helper uses.
interface StoredFile {
  bytes: Uint8Array;
  lastModified: number;
}

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, "NotFoundError");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

class FakeFileHandle {
  readonly kind = "file";
  readonly name: string;
  private readonly parent: FakeDirectory;

  constructor(name: string, parent: FakeDirectory) {
    this.name = name;
    this.parent = parent;
  }

  getFile(): Promise<File> {
    const stored = this.parent.files.get(this.name);
    if (!stored) return Promise.reject(notFound(this.name));
    return Promise.resolve(
      new File([stored.bytes as BlobPart], this.name, {
        lastModified: stored.lastModified,
      }),
    );
  }

  createWritable() {
    const parts: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write: (chunk) => {
        parts.push(new Uint8Array(chunk));
      },
      close: () => {
        this.parent.files.set(this.name, {
          bytes: concat(parts),
          lastModified: Date.now(),
        });
      },
    });
    return Promise.resolve(
      Object.assign(stream, {
        async write(chunk: Uint8Array) {
          const writer = stream.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
        },
      }),
    );
  }
}

class FakeDirectory {
  readonly kind = "directory";
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, StoredFile>();

  getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectory> {
    if (!this.directories.has(name) && !options.create) {
      return Promise.reject(notFound(name));
    }
    return Promise.resolve(this.child(name));
  }

  getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (!options.create) return Promise.reject(notFound(name));
      this.files.set(name, { bytes: new Uint8Array(), lastModified: 0 });
    }
    return Promise.resolve(new FakeFileHandle(name, this));
  }

  removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.directories.delete(name)) {
      return Promise.reject(notFound(name));
    }
    return Promise.resolve();
  }

  // Plain generators: `for await` takes them as readily as async ones.
  *entries(): Generator<[string, FakeDirectory | FakeFileHandle]> {
    yield* this.directories;
    for (const name of this.files.keys()) {
      yield [name, new FakeFileHandle(name, this)];
    }
  }

  *keys(): Generator<string> {
    for (const [name] of this.entries()) yield name;
  }

  child(name: string): FakeDirectory {
    let directory = this.directories.get(name);
    if (!directory) {
      directory = new FakeDirectory();
      this.directories.set(name, directory);
    }
    return directory;
  }

  /** Test helper: the folder at `path`, created as needed. */
  at(path: string): FakeDirectory {
    return path
      .split("/")
      .filter(Boolean)
      .reduce<FakeDirectory>((directory, name) => directory.child(name), this);
  }

  /** Test helper: put a file at `path`. */
  put(path: string, bytes: number[], lastModified = 1000): void {
    const segments = path.split("/").filter(Boolean);
    const name = segments.pop()!;
    this.at(segments.join("/")).files.set(name, {
      bytes: new Uint8Array(bytes),
      lastModified,
    });
  }
}

const PROFILE = "5-7";
const SAVES = `mkxpz/saves/${PROFILE}/mkxp-z/Saves`;

let root: FakeDirectory;

beforeEach(() => {
  root = new FakeDirectory();
  vi.stubGlobal("navigator", {
    ...navigator,
    storage: { getDirectory: () => Promise.resolve(root) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function downloadOf(bytes: number[], headers: Record<string, string> = {}) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(new Uint8Array(bytes), { status: 200, headers }),
    ),
  );
}

describe("mkxpzPaths", () => {
  it("places every folder below the mount the core shares with the page", () => {
    const paths = mkxpzPaths(PROFILE, "5-ab.mkxpz");

    expect(paths).toEqual({
      saveDirectory: `${MKXPZ_MOUNT}/mkxpz/saves/${PROFILE}`,
      stateDirectory: `${MKXPZ_MOUNT}/mkxpz/states/${PROFILE}`,
      systemDirectory: `${MKXPZ_MOUNT}/mkxpz/system`,
      game: `${MKXPZ_MOUNT}/mkxpz/games/5-ab.mkxpz`,
    });
  });

  it("creates the save, state and system folders", async () => {
    await ensureMkxpzDirectories(mkxpzPaths(PROFILE, "5-ab.mkxpz"));

    const mkxpz = root.directories.get("mkxpz")!;
    expect(mkxpz.directories.get("saves")!.directories.has(PROFILE)).toBe(true);
    expect(mkxpz.directories.get("states")!.directories.has(PROFILE)).toBe(
      true,
    );
    expect(mkxpz.directories.has("system")).toBe(true);
  });
});

describe("mkxpzGameFile", () => {
  const files = [
    { id: 1, file_size_bytes: 10, last_modified: "2026-01-01" },
    { id: 2, file_size_bytes: 20, last_modified: null },
  ];

  it("names an archive by rom and a digest of its files, in any order", async () => {
    const name = await mkxpzGameFile(5, files);

    expect(name).toMatch(/^5-[0-9a-f]{16}\.mkxpz$/);
    expect(await mkxpzGameFile(5, [...files].reverse())).toBe(name);
  });

  it("changes when a file changes", async () => {
    const before = await mkxpzGameFile(5, files);
    const after = await mkxpzGameFile(5, [
      files[0]!,
      { ...files[1]!, file_size_bytes: 21 },
    ]);

    expect(after).not.toBe(before);
  });
});

describe("cacheMkxpzGame", () => {
  it("downloads the archive once and marks it complete", async () => {
    const fetchMock = downloadOf([1, 2, 3]);
    vi.stubGlobal("fetch", fetchMock);

    await cacheMkxpzGame(5, "5-new.mkxpz", "/content");
    await cacheMkxpzGame(5, "5-new.mkxpz", "/content");

    const games = root.at("mkxpz/games");
    expect([...games.files.get("5-new.mkxpz")!.bytes]).toEqual([1, 2, 3]);
    expect(games.files.has("5-new.mkxpz.done")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports progress against the expected size without a Content-Length", async () => {
    vi.stubGlobal("fetch", downloadOf([1, 2, 3, 4]));
    const onProgress = vi.fn();

    await cacheMkxpzGame(5, "5-new.mkxpz", "/content", 8, onProgress);

    expect(onProgress).toHaveBeenLastCalledWith(4, 8);
  });

  it("prefers the response's Content-Length when it has one", async () => {
    vi.stubGlobal("fetch", downloadOf([1, 2], { "Content-Length": "2" }));
    const onProgress = vi.fn();

    await cacheMkxpzGame(5, "5-new.mkxpz", "/content", 99, onProgress);

    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it("removes older archives of the same rom only", async () => {
    vi.stubGlobal("fetch", downloadOf([1]));
    root.put("mkxpz/games/5-old.mkxpz", [9]);
    root.put("mkxpz/games/5-old.mkxpz.done", []);
    root.put("mkxpz/games/55-other.mkxpz", [9]);

    await cacheMkxpzGame(5, "5-new.mkxpz", "/content");

    expect([...root.at("mkxpz/games").files.keys()].sort()).toEqual([
      "5-new.mkxpz",
      "5-new.mkxpz.done",
      "55-other.mkxpz",
    ]);
  });

  it("leaves no completion marker when the download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );

    await expect(cacheMkxpzGame(5, "5-new.mkxpz", "/content")).rejects.toThrow(
      "500",
    );
    expect(root.at("mkxpz/games").files.has("5-new.mkxpz.done")).toBe(false);
  });
});

describe("readMkxpzSaves", () => {
  it("is empty before the core made a save folder", async () => {
    expect(await readMkxpzSaves(PROFILE)).toEqual([]);
  });

  it("reads one slot per file, named by its title folder", async () => {
    root.put(`${SAVES}/Crysalis-/Save01.rvdata2`, [7, 8], 4242);

    const saves = await readMkxpzSaves(PROFILE);

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      slot: "Crysalis-/Save01.rvdata2",
      fileName: "Save01.rvdata2",
      updatedAt: 4242,
    });
    expect([...saves[0]!.bytes]).toEqual([7, 8]);
  });

  it("skips files beside the title folders and folders inside them", async () => {
    root.put(`${SAVES}/stray.txt`, [1]);
    root.put(`${SAVES}/Game-/nested/Save1.rxdata`, [1]);

    expect(await readMkxpzSaves(PROFILE)).toEqual([]);
  });

  it("keeps each user's saves apart", async () => {
    root.put(`mkxpz/saves/5-8/mkxp-z/Saves/Game-/Save1.rxdata`, [1]);

    expect(await readMkxpzSaves(PROFILE)).toEqual([]);
  });
});

describe("writeMkxpzSaves", () => {
  it("puts a save where the core reads it back", async () => {
    await writeMkxpzSaves(PROFILE, [
      { slot: "Game-/Save1.rxdata", bytes: new Uint8Array([3, 4]) },
    ]);

    const [save] = await readMkxpzSaves(PROFILE);
    expect(save?.slot).toBe("Game-/Save1.rxdata");
    expect([...save!.bytes]).toEqual([3, 4]);
  });

  it.each(["Save1.rxdata", "a/b/Save1.rxdata", "../Save1.rxdata", "Game-/.."])(
    "ignores a slot that names no single title folder and file: %s",
    async (slot) => {
      await writeMkxpzSaves(PROFILE, [{ slot, bytes: new Uint8Array([1]) }]);

      expect(await readMkxpzSaves(PROFILE)).toEqual([]);
      expect(root.at(SAVES).files.size).toBe(0);
    },
  );
});

describe("deleteMkxpzSaves", () => {
  it("removes the named slots and leaves the rest", async () => {
    root.put(`${SAVES}/Game-/Save1.rxdata`, [1]);
    root.put(`${SAVES}/Game-/Save2.rxdata`, [2]);

    await deleteMkxpzSaves(PROFILE, [
      "Game-/Save1.rxdata",
      "Gone-/Save9.rxdata",
    ]);

    const saves = await readMkxpzSaves(PROFILE);
    expect(saves.map((save) => save.slot)).toEqual(["Game-/Save2.rxdata"]);
  });
});
