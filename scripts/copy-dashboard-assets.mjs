import { cpSync } from "node:fs";

cpSync("src/dashboard/assets", "dist/dashboard/assets", { recursive: true });
