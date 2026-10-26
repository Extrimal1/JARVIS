import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { batchesConfig } from "@/src/lib/api/modules/finance";

export const { GET, POST } = collectionRoutes(
  batchesConfig,
  "finance/batches",
);
