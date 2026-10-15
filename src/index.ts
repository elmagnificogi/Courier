import fs from "fs";
import path from "path";
import { startHealthServer } from "./health/HealthServer";
import { TelegramBotService } from "./telegram/TelegramBotService";
import { config, enabledAdapterNames, ideDisplayName } from "./config";
import { logger } from "./logger";
import { DiscordService } from "./platform/DiscordService";
import { EmailService } from "./platform/EmailService";
import { notificationHub } from "./platform/NotificationHub";
import { runStartupPreflightCheck } from "./cdp/CdpPreflightCheck";

function consumeRestartFlag(): boolean {
  const flag = path.resolve(process.cwd(), "tmp", "courier-restart.flag");
  try {
    if (!fs.existsSync(flag)) {
      return false;
    }
    fs.unlinkSync(flag);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const restarted = consumeRestartFlag();
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

  if (restarted) {
    notificationHub.notifyAll("Courier 已重启并上线。").catch((error) => {
      logger.warn({ error }, "Failed to send restart-online notify");
    });
  }

  runStartupPreflightCheck((msg) => notificationHub.notifyAll(msg)).catch(() => {});
}

main().catch((error) => {
  logger.error({ error }, "Fatal startup error");
  process.exit(1);
});
