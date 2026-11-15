type ScopedAvatar = {
  id: string;
  version?: string | null;
};

export const scopedAvatarPath = (
  scope: "drawing" | "drawing-share" | "collection-share",
  resourceId: string,
  { id, version }: ScopedAvatar,
): string | undefined => {
  if (!version) return;
  const resource = scope === "collection-share" ? "collections" : "drawings";
  const route = scope === "drawing" ? "avatars" : "share-avatars";
  return `/${resource}/${encodeURIComponent(resourceId)}/${route}/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
};
