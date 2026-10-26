import { itemRoutes } from "@/src/lib/api/routeFactory";
import { transactionsConfig } from "@/src/lib/api/modules/finance";

export const { PATCH, DELETE } = itemRoutes(
  transactionsConfig,
  "finance/transactions",
);
