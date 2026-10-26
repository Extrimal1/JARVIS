import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { lifestyleEventsConfig } from "@/src/lib/api/modules/lifestyle";

export const { GET, POST } = collectionRoutes(
  lifestyleEventsConfig,
  "lifestyle/events",
);
