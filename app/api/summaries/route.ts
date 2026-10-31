import { summariesConfig } from "@/src/lib/api/modules/summaries";
import { collectionRoutes } from "@/src/lib/api/routeFactory";

export const { GET, POST } = collectionRoutes(summariesConfig, "summaries");
