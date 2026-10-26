import { itemRoutes } from "@/src/lib/api/routeFactory";
import { studyConfig } from "@/src/lib/api/modules/study";

export const { PATCH, DELETE } = itemRoutes(studyConfig, "study");
