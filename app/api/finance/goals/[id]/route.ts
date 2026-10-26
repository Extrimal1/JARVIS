import { itemRoutes } from "@/src/lib/api/routeFactory";
import { goalsConfig } from "@/src/lib/api/modules/finance";

export const { PATCH, DELETE } = itemRoutes(goalsConfig, "finance/goals");
