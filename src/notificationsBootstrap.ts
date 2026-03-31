import { Notifier, NotificationConfig } from './notifications';

export interface FileNotificationsConfig {
  enabled: boolean;
  webhookUrl: string;
  type: 'discord' | 'telegram';
  botToken?: string;
}

export function buildNotifierFromConfig(cfg?: FileNotificationsConfig): Notifier {
  const resolved: NotificationConfig = {
    enabled: cfg?.enabled ?? false,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? cfg?.webhookUrl ?? '',
    type: (cfg?.type ?? 'discord') as 'discord' | 'telegram',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
  };

  return new Notifier(resolved);
}

export function resolveDiscordBotToken(cfg?: FileNotificationsConfig): string {
  return process.env.DISCORD_BOT_TOKEN ?? cfg?.botToken ?? '';
}
