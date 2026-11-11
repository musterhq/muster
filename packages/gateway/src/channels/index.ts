import { ChannelRegistry } from "../channel-sdk.js";
import { discordChannel } from "./discord.js";
import { emailChannel } from "./email.js";
import { googleChatChannel } from "./googlechat.js";
import { matrixChannel } from "./matrix.js";
import { slackChannel } from "./slack.js";
import { teamsChannel } from "./teams.js";
import { telegramChannel } from "./telegram.js";
import { whatsAppChannel } from "./whatsapp.js";
import { whatsAppCloudChannel } from "./whatsapp-cloud.js";

export { emailChannel, emailSurfaceId, parseEmailMessage } from "./email.js";
export type { ParsedEmail } from "./email.js";
export { matrixChannel, matrixSurfaceId } from "./matrix.js";
export { slackChannel } from "./slack.js";
export { telegramChannel } from "./telegram.js";
export { callDiscord, discordApiBase, discordBotToken, discordChannel, discordGatewayMessageToSurfaceMessage, respondToDiscordInteraction } from "./discord.js";
export type { DiscordGatewayMessage, DiscordInteractionHandle } from "./discord.js";
export { googleChatChannel, googleChatUsesApi } from "./googlechat.js";
export { teamsChannel, teamsUsesBotFramework } from "./teams.js";
export { BOT_FRAMEWORK_ISSUER, botFrameworkAccessToken, verifyBotFrameworkToken } from "./bot-framework.js";
export { createWhatsAppChannel, whatsAppAccount, whatsAppChannel } from "./whatsapp.js";
export type { WhatsAppChannelOptions } from "./whatsapp.js";
export { WHATSAPP_MEDIA_URL_PREFIX, whatsAppCloudAccessToken, whatsAppCloudChannel, whatsAppCloudSignatureIsValid, whatsAppCloudToSurfaceMessages } from "./whatsapp-cloud.js";

/** A fresh registry with every built-in SDK channel. */
export function defaultChannelRegistry(): ChannelRegistry {
  return new ChannelRegistry([
    telegramChannel,
    slackChannel,
    matrixChannel,
    emailChannel,
    discordChannel,
    whatsAppCloudChannel,
    whatsAppChannel,
    googleChatChannel,
    teamsChannel,
  ]);
}
