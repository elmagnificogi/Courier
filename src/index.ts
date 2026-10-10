import { startHealthServer } from "./health/HealthServer";
import { TelegramBotService } from "./telegram/TelegramBotService";
import { config, enabledAdapterNames, ideDisplayName } from "./config";
import { logger } from "./logger";
import { DiscordService } from "./platform/DiscordService";
import { EmailService } from "./platform/EmailService";
import { notificationHub } from "./platform/NotificationHub";
import { runStartupPreflightCheck } from "./cdp/CdpPreflightCheck";

async function main(): Promise<void> {
  const bot = new TelegramBotService();
  const discord = new DiscordService();
  const email = new EmailService();
  bot.start();
  discord.start();
  email.start();
  startHealthServer();
  const ideName = ideDisplayName();
  logger.info(
    `${ideName} multi-platform bridge started (default=${config.bridgeIdeTarget}, port=${config.port}, adapters=${enabledAdapterNames().join(",")}; /targets lists every IDE window)`
  );

  runStartupPreflightCheck((msg) => notificationHub.notifyAll(msg)).catch(() => {});
}

main().catch((error) => {
  logger.error({ error }, "Fatal startup error");
  process.exit(1);
});
