import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { conversationMessagesConfig } from "@/src/lib/api/modules/conversations";

export const { GET, POST } = collectionRoutes(
  conversationMessagesConfig,
  "conversation-messages",
);
