import express from "express";
import { registerDashboardProfileAvatars } from "./profileAvatars";
import { registerCollectionRoutes } from "./collections";
import { registerDrawingRoutes } from "./drawings";
import { registerLibraryRoutes } from "./library";
import { DashboardRouteDeps } from "./types";

export const registerDashboardRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  registerDrawingRoutes(app, deps);
  registerCollectionRoutes(app, deps);
  registerDashboardProfileAvatars(app, deps);
  registerLibraryRoutes(app, deps);
};

export type { DashboardRouteDeps } from "./types";
