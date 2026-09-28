import axios from "axios";

// Shared axios client for the Traccar REST API. Kept free of the logger import so services can use it.
const apiUrl = process.env.TRACCARR_API_URL;
const apiToken = process.env.TRACCARR_API_TOKEN;

export const isTraccarConfigured = Boolean(apiUrl && apiToken);

export const traccarHttp = axios.create({
  baseURL: apiUrl,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${apiToken}`,
  },
});
