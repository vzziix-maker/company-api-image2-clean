import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function enforceLoopbackHost() {
  return {
    name: "enforce-loopback-host",
    configResolved(config) {
      for (const [label, value] of [["development", config.server.host], ["preview", config.preview.host]]) {
        const host = value === true ? "0.0.0.0" : String(value || "");
        if (!LOOPBACK_HOSTS.has(host)) {
          throw new Error("Jomage2 only allows loopback " + label + " hosts; received " + (host || "unspecified") + ".");
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [enforceLoopbackHost(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43288,
    proxy: {
      "/api": process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:43287",
    },
  },
  preview: {
    host: "127.0.0.1",
  },
});
