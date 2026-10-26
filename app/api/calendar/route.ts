import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { calendarConfig } from "@/src/lib/api/modules/calendar";

export const { GET, POST } = collectionRoutes(calendarConfig, "calendar");
