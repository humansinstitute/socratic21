import { defineConfig } from "vite";

const allowedHosts = [
  "localhost",
  "127.0.0.1",
  ".otherstuff.ai",
  ".otherstuff.studio",
  ".rick.runwingman.com",
];

export default defineConfig({
  envPrefix: ["VITE_", "WORKSPACE_OWNER_"],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts,
  },
});
