import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { plansConfig } from "@/src/lib/api/modules/lifestyle";

export const { GET, POST } = collectionRoutes(plansConfig, "lifestyle/plans");
