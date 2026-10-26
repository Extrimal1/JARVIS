import { itemRoutes } from "@/src/lib/api/routeFactory";
import { memoryConfig } from "@/src/lib/api/modules/memory";

export const { PATCH, DELETE } = itemRoutes(memoryConfig, "memory");
