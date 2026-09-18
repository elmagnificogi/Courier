import { logger } from "../logger";

type NotifyFn = (text: string) => Promise<void>;

class NotificationHubImpl {
  private readonly sinks: Array<{ name: string; notify: NotifyFn }> = [];

  register(name: string, notify: NotifyFn): void {
    this.sinks.push({ name, notify });
  }

  async notifyAll(text: string): Promise<void> {
    if (this.sinks.length === 0) {
      logger.debug("notifyAll: no IM sinks registered");
      return;
    }
    await Promise.allSettled(
      this.sinks.map(async (sink) => {
        try {
          await sink.notify(text);
        } catch (error) {
          logger.warn({ error, sink: sink.name }, "IM notification failed");
        }
      })
    );
  }
}

export const notificationHub = new NotificationHubImpl();
