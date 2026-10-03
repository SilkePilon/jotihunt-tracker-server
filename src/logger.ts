import winston from "winston";

export const debug = process.env.DEBUG === "true";

// Setup logging with Winston
export const logger = winston.createLogger({
  level: debug ? "debug" : "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.simple(),
        winston.format.printf((info) => `${info.timestamp} - ${info.level}: ${info.message}`),
      ),
    }),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});
