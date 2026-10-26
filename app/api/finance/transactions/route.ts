import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { transactionsConfig } from "@/src/lib/api/modules/finance";

export const { GET, POST } = collectionRoutes(
  transactionsConfig,
  "finance/transactions",
);
