import { api } from "./client";

export type GuestLinkSession = {
  expiresAt: string;
  permission: "view" | "edit";
  drawingId: string;
};

export const GUEST_SHARE_HEADER = "X-Guest-Share";

export const guestShareHeaders = (shareId?: string) =>
  shareId ? { [GUEST_SHARE_HEADER]: shareId } : undefined;

export const getGuestLinkSession = async (
  shareId: string,
): Promise<GuestLinkSession> => {
  const response = await api.get<GuestLinkSession>(
    `/guest-links/${encodeURIComponent(shareId)}/session`,
    { headers: guestShareHeaders(shareId) },
  );
  return response.data;
};

export const unlockGuestLink = async (
  shareId: string,
  token: string,
  passphrase?: string,
): Promise<GuestLinkSession> => {
  const response = await api.post<GuestLinkSession>(
    `/guest-links/${encodeURIComponent(shareId)}/unlock`,
    { token, passphrase },
    { headers: guestShareHeaders(shareId) },
  );
  return response.data;
};
