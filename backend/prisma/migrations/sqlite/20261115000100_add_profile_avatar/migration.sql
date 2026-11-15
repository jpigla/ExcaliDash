CREATE TABLE "UserAvatar" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "png" BLOB NOT NULL,
    CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
