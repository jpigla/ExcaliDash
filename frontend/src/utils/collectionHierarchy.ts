import type { Collection } from "../types";

export const getCollectionPath = (
  collection: Collection,
  byId: ReadonlyMap<string, Collection>,
): string => {
  const names = [collection.name];
  const seen = new Set([collection.id]);
  let parentId = collection.parentId;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    names.push(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return names.reverse().join(" / ");
};

export const getCollectionRows = (collections: Collection[]) => {
  const ids = new Set(collections.map((collection) => collection.id));
  const childrenByParent = new Map<string | null, Collection[]>();
  for (const collection of collections) {
    const parentId =
      collection.parentId && ids.has(collection.parentId)
        ? collection.parentId
        : null;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(collection);
    else childrenByParent.set(parentId, [collection]);
  }

  const rows: { collection: Collection; depth: number }[] = [];
  const pending = (childrenByParent.get(null) ?? [])
    .map((collection) => ({ collection, depth: 0 }))
    .reverse();
  while (pending.length > 0) {
    const row = pending.pop()!;
    rows.push(row);
    const children = childrenByParent.get(row.collection.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ collection: children[i], depth: row.depth + 1 });
    }
  }
  return rows;
};
