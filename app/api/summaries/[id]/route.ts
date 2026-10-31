import { summariesConfig } from "@/src/lib/api/modules/summaries";
import { itemRoutes } from "@/src/lib/api/routeFactory";

export const { PATCH, DELETE } = itemRoutes(summariesConfig, "summaries");
