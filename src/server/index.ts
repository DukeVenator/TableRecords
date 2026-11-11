import { loadConfig } from "./config.js";
import { TableRecordsApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new TableRecordsApp(config);
  await app.init();
  const address = await app.listen();
  console.log(`TableRecords ${config.host}:${config.port} — ${address}`);
  console.log(`Dashboard: http://${config.host}:${config.port}`);
  console.log(`Sessions:  ${config.sessionsDir}`);
  if (!config.discordToken) {
    console.log("Discord:   not configured (set DISCORD_TOKEN in .env; the dashboard still works)");
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] shutting down; finalizing capture state...`);
    try {
      await app.close();
    } catch (error) {
      console.error("Shutdown error:", error);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });
}

main().catch((error) => {
  console.error("TableRecords failed to start:", error);
  process.exit(1);
});
