import React from "react";
import clsx from "clsx";
import { API_URL } from "../api/client";
import { getInitialsFromName } from "../utils/user";

type UserAvatarProps = {
  name: string;
  avatarVersion?: string | null;
  avatarPath?: string;
  size?: "sm" | "toolbar" | "md" | "lg";
  className?: string;
};

const sizeClasses = {
  sm: "h-8 w-8 text-[11px]",
  toolbar: "h-10 w-10 text-xs",
  md: "h-12 w-12 text-sm",
  lg: "h-20 w-20 text-2xl",
};

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name,
  avatarVersion,
  avatarPath,
  size = "md",
  className,
}) => {
  const [failedImage, setFailedImage] = React.useState<string>();
  const path =
    avatarPath ??
    (avatarVersion
      ? `/auth/profile/avatar/${encodeURIComponent(avatarVersion)}`
      : undefined);
  return (
    <div
      className={clsx("playful-avatar", sizeClasses[size], className)}
      aria-label={`${name}'s profile picture`}
      role="img"
    >
      {path && path !== failedImage ? (
        <img
          src={`${API_URL}${path}`}
          crossOrigin="use-credentials"
          alt=""
          className="h-full w-full rounded-[inherit] object-cover"
          onError={() => setFailedImage(path)}
        />
      ) : (
        getInitialsFromName(name)
      )}
    </div>
  );
};
