import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { placesConfig } from "@/src/lib/api/modules/lifestyle";

export const { GET, POST } = collectionRoutes(
  placesConfig,
  "lifestyle/places",
);
