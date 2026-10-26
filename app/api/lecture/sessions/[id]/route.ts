import { itemRoutes } from "@/src/lib/api/routeFactory";
import { sessionsConfig } from "@/src/lib/api/modules/lecture";

export const { PATCH, DELETE } = itemRoutes(
  sessionsConfig,
  "lecture/sessions",
);
