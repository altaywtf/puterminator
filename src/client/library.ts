import { FileFlag, type Library } from "../shared/contract";

export type Node = {
  id: number;
  parent: number;
  name: string;
  size: number;
  flags: number;
  /** Relative to the scan root, as tool results write it: `/Movies/Heat.mkv`. */
  path: string;
  depth: number;
  children: number[];
  /** Files under a folder (itself for a file) that are junk / never-played videos. */
  junk: number;
  unplayed: number;
};

export type Index = {
  rootId: number;
  rootName: string;
  nodes: Map<number, Node>;
  top: number[];
  total: number;
  byPath: Map<string, number>;
  /** File name → id; -1 when two files share the name. */
  byName: Map<string, number>;
};

export const has = (n: Node, flag: number) => (n.flags & flag) !== 0;
export const isFolder = (n: Node) => has(n, FileFlag.folder);
export const putioUrl = (id: number) => `https://app.put.io/files/${id}`;

/** put.io lists special folders with negative ids (shared items); they can't be targeted or opened by id. */
export const isRegular = (n: Node) => n.id >= 0;

const bySize = (nodes: Map<number, Node>) => (a: number, b: number) =>
  Number(a < 0) - Number(b < 0) || (nodes.get(b)?.size ?? 0) - (nodes.get(a)?.size ?? 0);

const build = (lib: Library): Index => {
  const nodes = new Map<number, Node>();

  for (const [id, parent, name, size, flags] of lib.files)
    nodes.set(id, { id, parent, name, size, flags, path: "", depth: 0, children: [], junk: 0, unplayed: 0 });
  const top: number[] = [];

  for (const n of nodes.values()) (n.parent === lib.rootId ? top : nodes.get(n.parent)?.children)?.push(n.id);

  const byPath = new Map<string, number>();
  const byName = new Map<string, number>();
  const order = bySize(nodes);

  const walk = (id: number, prefix: string, depth: number) => {
    const n = nodes.get(id);

    if (!n) return;
    n.path = `${prefix}/${n.name}`;
    n.depth = depth;
    byPath.set(n.path, id);

    if (!isFolder(n)) byName.set(n.name, byName.has(n.name) ? -1 : id);

    for (const c of n.children) walk(c, n.path, depth + 1);
    n.children.sort(order);

    if (isFolder(n)) {
      let sum = 0;

      for (const c of n.children) {
        const child = nodes.get(c);

        if (child) {
          n.junk += child.junk;
          n.unplayed += child.unplayed;
          sum += child.size;
        }
      }

      n.size = Math.max(n.size, sum);
    } else {
      n.junk = has(n, FileFlag.junk) ? 1 : 0;
      n.unplayed = has(n, FileFlag.video) && !has(n, FileFlag.played) ? 1 : 0;
    }
  };

  for (const id of top) walk(id, "", 1);
  top.sort(order);
  const total = top.reduce((a, id) => a + (id < 0 ? 0 : (nodes.get(id)?.size ?? 0)), 0);

  return { rootId: lib.rootId, rootName: lib.rootName, nodes, top, total, byPath, byName };
};

const cache = new WeakMap<Library, Index>();

/** One index per library frame; the frame object is replaced on every scan. */
export const indexOf = (lib: Library): Index => {
  const hit = cache.get(lib);

  if (hit) return hit;
  const built = build(lib);
  cache.set(lib, built);

  return built;
};

export const libraryIndex = (lib: Library | null): Index | null => (lib ? indexOf(lib) : null);

/** A path or file name as the model or a tool wrote it, matched to one snapshot entry. */
export const resolve = (ix: Index, text: string): Node | null => {
  const t = text.trim().replace(/\/+$/, "");

  if (!t) return null;
  const id = ix.byPath.get(t.startsWith("/") ? t : `/${t}`) ?? ix.byName.get(t);

  return id === undefined || id === -1 ? null : (ix.nodes.get(id) ?? null);
};
