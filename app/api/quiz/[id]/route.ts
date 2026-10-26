import { itemRoutes } from "@/src/lib/api/routeFactory";
import { quizConfig } from "@/src/lib/api/modules/quiz";

export const { PATCH, DELETE } = itemRoutes(quizConfig, "quiz");
