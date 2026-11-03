/** The put.io file fields the scan keeps. */
export type PutioFile = {
  id: number;
  parent_id: number | null;
  name: string;
  size: number;
  file_type: string;
  extension: string | null;
  crc32: string | null;
  created_at: string;
  first_accessed_at: string | null;
};

export type WalkedFile = PutioFile & { path: string; depth: number };

/** Rebuilds paths for everything under `rootId` (0 is Your Files) from the flat, unordered `listAll`. */
export function buildTree(all: readonly PutioFile[], rootId: number) {
  const byId = new Map(all.map((f) => [f.id, f]));
  const memo = new Map<number, { path: string; depth: number } | null>([[rootId, { path: "", depth: 0 }]]);

  const place = (id: number, seen = new Set<number>()): { path: string; depth: number } | null => {
    const hit = memo.get(id);

    if (hit !== undefined) return hit;
    const f = byId.get(id);

    if (!f || f.parent_id == null || seen.has(id)) return null;
    seen.add(id);
    const parent = place(f.parent_id, seen);
    const here = parent && { path: `${parent.path}/${f.name}`, depth: parent.depth + 1 };
    memo.set(id, here);

    return here;
  };

  const files: WalkedFile[] = [];

  for (const f of all) {
    if (f.id === rootId) continue;
    const at = place(f.id);

    if (at) files.push({ ...f, ...at });
  }

  return { files, rootName: rootId === 0 ? "Your Files" : (byId.get(rootId)?.name ?? "Your Files") };
}
