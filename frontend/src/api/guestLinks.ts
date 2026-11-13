import { api } from "./client";

export type GuestLinkSession = {
  session: string;
  expiresAt: string;
  permission: "view" | "edit";
  drawingId: string;
};

export const guestAuthorization = (session?: string) =>
  session ? { Authorization: `Guest ${session}` } : undefined;

export const unlockGuestLink = async (
  shareId: string,
  token: string,
  passphrase?: string,
): Promise<GuestLinkSession> => {
  const response = await api.post<GuestLinkSession>(
    `/guest-links/${encodeURIComponent(shareId)}/unlock`,
    { token, passphrase },
  );
  return response.data;
};
