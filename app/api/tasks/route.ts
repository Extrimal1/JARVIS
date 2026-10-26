import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { tasksConfig } from "@/src/lib/api/modules/tasks";

export const { GET, POST } = collectionRoutes(tasksConfig, "tasks");
