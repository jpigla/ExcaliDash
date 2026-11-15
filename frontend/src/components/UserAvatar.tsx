import React from "react";
import clsx from "clsx";
import { API_URL } from "../api/client";
import { getInitialsFromName } from "../utils/user";

type UserAvatarProps = {
  name: string;
  avatarVersion?: string | null;
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
  size = "md",
  className,
}) => {
  const [failedImage, setFailedImage] = React.useState<string>();
  return (
    <div
      className={clsx("playful-avatar", sizeClasses[size], className)}
      aria-label={`${name}'s profile picture`}
      role="img"
    >
      {avatarVersion && avatarVersion !== failedImage ? (
        <img
          src={`${API_URL}/auth/profile/avatar/${encodeURIComponent(avatarVersion)}`}
          crossOrigin="use-credentials"
          alt=""
          className="h-full w-full rounded-[inherit] object-cover"
          onError={() => setFailedImage(avatarVersion)}
        />
      ) : (
        getInitialsFromName(name)
      )}
    </div>
  );
};
