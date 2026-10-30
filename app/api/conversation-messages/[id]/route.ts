import { itemRoutes } from "@/src/lib/api/routeFactory";
import { conversationMessagesConfig } from "@/src/lib/api/modules/conversations";

export const { PATCH, DELETE } = itemRoutes(
  conversationMessagesConfig,
  "conversation-messages",
);
