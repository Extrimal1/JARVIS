import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { memoryConfig } from "@/src/lib/api/modules/memory";

export const { GET, POST } = collectionRoutes(memoryConfig, "memory");
