import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { conversationThreadsConfig } from "@/src/lib/api/modules/conversations";

export const { GET, POST } = collectionRoutes(
  conversationThreadsConfig,
  "conversations",
);
