import { itemRoutes } from "@/src/lib/api/routeFactory";
import { placesConfig } from "@/src/lib/api/modules/lifestyle";

export const { PATCH, DELETE } = itemRoutes(
  placesConfig,
  "lifestyle/places",
);
