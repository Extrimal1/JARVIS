import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { goalsConfig } from "@/src/lib/api/modules/finance";

export const { GET, POST } = collectionRoutes(goalsConfig, "finance/goals");
