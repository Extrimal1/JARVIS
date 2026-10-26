import { itemRoutes } from "@/src/lib/api/routeFactory";
import { tasksConfig } from "@/src/lib/api/modules/tasks";

export const { PATCH, DELETE } = itemRoutes(tasksConfig, "tasks");
