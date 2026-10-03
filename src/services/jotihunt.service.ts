import axios from "axios";
import { logger } from "../logger";
import {ApiArea, ApiArticle, ApiTeam} from "../types/api";

const apiUrl = process.env.JOTIHUNT_API_URL as string;

const apiClient = axios.create({
    baseURL: apiUrl,
    // Crons run with noOverlap, so a hanging request would stop them for good
    timeout: 10_000,
});

/**
 * Function to get all areas from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of areas.
 */
export async function getAreas(): Promise<ApiArea[]> {
    try {
        const response = await apiClient.get("/areas");
        return response.data.data as ApiArea[];
    } catch (error) {
        logger.error("Error fetching areas:", error);
        throw new Error("Could not fetch areas", { cause: error });
    }
}

/**
 * Function to get all articles from Jotihunt.
 * Only returns the first 15 articles.
 * @returns {Promise<Array>} - A promise that resolves to an array of articles.
 */
export async function getArticles(): Promise<ApiArticle[]> {
    try {
        const response = await apiClient.get("/articles");
        return response.data.data as ApiArticle[];
    } catch (error) {
        logger.error("Error fetching articles:", error);
        throw new Error("Could not fetch articles", { cause: error });
    }
}

/**
 * Function to get all subscribed teams (groups) from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of teams.
 */
export async function getTeams(): Promise<ApiTeam[]> {
    try {
        const response = await apiClient.get("/subscriptions");
        return response.data.data as ApiTeam[];
    } catch (error) {
        logger.error("Error fetching teams:", error);
        throw new Error("Could not fetch teams", { cause: error });
    }
}
