import { itemRoutes } from "@/src/lib/api/routeFactory";
import { lifestyleEventsConfig } from "@/src/lib/api/modules/lifestyle";

export const { PATCH, DELETE } = itemRoutes(
  lifestyleEventsConfig,
  "lifestyle/events",
);
