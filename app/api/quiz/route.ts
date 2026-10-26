import { collectionRoutes } from "@/src/lib/api/routeFactory";
import { quizConfig } from "@/src/lib/api/modules/quiz";

export const { GET, POST } = collectionRoutes(quizConfig, "quiz");
