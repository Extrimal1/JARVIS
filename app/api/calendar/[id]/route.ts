import { itemRoutes } from "@/src/lib/api/routeFactory";
import { calendarConfig } from "@/src/lib/api/modules/calendar";

export const { PATCH, DELETE } = itemRoutes(calendarConfig, "calendar");
