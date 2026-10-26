import { itemRoutes } from "@/src/lib/api/routeFactory";
import { recordingsConfig } from "@/src/lib/api/modules/lecture";

export const { PATCH, DELETE } = itemRoutes(
  recordingsConfig,
  "lecture/recordings",
);
