import { itemRoutes } from "@/src/lib/api/routeFactory";
import { conversationThreadsConfig } from "@/src/lib/api/modules/conversations";

export const { PATCH, DELETE } = itemRoutes(
  conversationThreadsConfig,
  "conversations",
);
