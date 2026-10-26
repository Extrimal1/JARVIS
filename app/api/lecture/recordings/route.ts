import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { recordingsConfig } from "@/src/lib/api/modules/lecture";

export const { GET, POST } = collectionRoutes(
  recordingsConfig,
  "lecture/recordings",
);
