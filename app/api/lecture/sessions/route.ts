import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { sessionsConfig } from "@/src/lib/api/modules/lecture";

export const { GET, POST } = collectionRoutes(
  sessionsConfig,
  "lecture/sessions",
);
