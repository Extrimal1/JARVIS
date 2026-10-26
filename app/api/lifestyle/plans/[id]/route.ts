import { itemRoutes } from "@/src/lib/api/routeFactory";
import { plansConfig } from "@/src/lib/api/modules/lifestyle";

export const { PATCH, DELETE } = itemRoutes(plansConfig, "lifestyle/plans");
