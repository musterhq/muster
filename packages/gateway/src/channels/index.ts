import { ChannelRegistry } from "../channel-sdk.js";
import { emailChannel } from "./email.js";
import { matrixChannel } from "./matrix.js";
import { slackChannel } from "./slack.js";
import { telegramChannel } from "./telegram.js";

export { emailChannel, emailSurfaceId, parseEmailMessage } from "./email.js";
export type { ParsedEmail } from "./email.js";
export { matrixChannel, matrixSurfaceId } from "./matrix.js";
export { slackChannel } from "./slack.js";
export { telegramChannel } from "./telegram.js";

/** A fresh registry with every built-in SDK channel. */
export function defaultChannelRegistry(): ChannelRegistry {
  return new ChannelRegistry([telegramChannel, slackChannel, matrixChannel, emailChannel]);
}
