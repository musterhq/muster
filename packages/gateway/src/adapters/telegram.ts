import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceAttachment, SurfaceMessage, SurfaceReply } from "../envelope.js";
import {
  approvalFallbackText,
  bindSurfaceAction,
  issueApprovalActions,
  parseSurfaceAction,
  pendingApprovalSurfaceFields,
  sanitizePresentationForAudience,
} from "../presentation.js";
import type { ApprovalActionParser, ApprovalActionRenderContext, SurfaceAction, SurfacePresentation } from "../presentation.js";

/**
 * Telegram Bot API adapter: PURE mappers only (no network). The gateway
 * server receives webhook updates on POST /v1/adapters/telegram and sends
 * outbound payloads to https://api.telegram.org/bot<token>/sendMessage.
 */

export const TELEGRAM_SURFACE_ID = "telegram:bot";

const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const TELEGRAM_MESSAGE_BUDGET = 3_900;
const TELEGRAM_MAX_TABLE_ROWS = 10;
const TELEGRAM_MAX_TREND_POINTS = 8;
const TELEGRAM_GROUP_WIDTH = 68;
const TELEGRAM_BUTTON_LABEL_LENGTH = 40;
const TELEGRAM_BOX_DRAWING = /[\u2500-\u257f]/g;

export interface TelegramMappingOptions {
  readonly approvalActions?: ApprovalActionParser;
}

export interface TelegramRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: {
    readonly message_id?: number;
    readonly from?: { readonly id?: number | string };
    readonly chat?: { readonly id?: number | string };
    readonly text?: string;
    readonly caption?: string;
    readonly reply_to_message?: { readonly message_id?: number };
    readonly voice?: TelegramFile;
    readonly audio?: TelegramFile;
    readonly document?: TelegramFile;
  };
  readonly callback_query?: {
    readonly id?: string;
    readonly from?: { readonly id?: number | string };
    readonly data?: string;
    readonly message?: {
      readonly message_id?: number;
      readonly chat?: { readonly id?: number | string };
    };
  };
}

interface TelegramFile {
  readonly file_id?: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
  readonly duration?: number;
}

/** Pseudo-url for a Telegram file; the channel adapter resolves it with getFile. */
export const TELEGRAM_FILE_URL_PREFIX = "telegram-file:";

/** Voice notes, audio files and audio documents as attachments (the shared voice path transcribes them). */
function telegramAudioAttachments(message: NonNullable<TelegramUpdate["message"]>): SurfaceAttachment[] {
  const out: SurfaceAttachment[] = [];
  const add = (file: TelegramFile | undefined, fallbackName: string, fallbackMime: string) => {
    if (!file?.file_id) return;
    const mime = file.mime_type ?? fallbackMime;
    if (!mime.startsWith("audio/")) return;
    out.push({
      name: file.file_name ?? fallbackName,
      mime,
      url: `${TELEGRAM_FILE_URL_PREFIX}${file.file_id}`,
      ...(typeof file.duration === "number" ? { seconds: file.duration } : {}),
      ...(typeof file.file_size === "number" ? { sizeBytes: file.file_size } : {}),
    });
  };
  add(message.voice, "voice.ogg", "audio/ogg");
  add(message.audio, "audio", "audio/mpeg");
  add(message.document, "document", "application/octet-stream");
  return out;
}

/** Map a Telegram update to the gateway envelope. Updates with neither text nor audio map to undefined. */
export function telegramUpdateToSurfaceMessage(update: unknown, options: TelegramMappingOptions = {}): SurfaceMessage | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const typed = update as TelegramUpdate;
  const callback = typed.callback_query;
  const approval = callback?.message?.chat?.id && callback.from?.id
    ? pendingApprovalSurfaceFields(options.approvalActions, callback.data, {
      actorId: String(callback.from.id),
      surfaceId: TELEGRAM_SURFACE_ID,
      conversationId: String(callback.message.chat.id),
    }, update)
    : undefined;
  const command = approval?.text ?? parseSurfaceAction(callback?.data);
  if (callback?.message?.chat?.id && callback.from?.id && command) {
    return {
      surfaceId: TELEGRAM_SURFACE_ID,
      conversationId: String(callback.message.chat.id),
      senderId: String(callback.from.id),
      text: command,
      replyTo: callback.message.message_id === undefined ? undefined : String(callback.message.message_id),
      raw: approval?.raw ?? update,
    };
  }
  const message = typed.message;
  if (!message?.chat?.id || !message.from?.id) return undefined;
  const text = message.text ?? message.caption ?? "";
  const attachments = telegramAudioAttachments(message);
  if (typeof text !== "string" || (!text.trim() && !attachments.length)) return undefined;
  return {
    surfaceId: TELEGRAM_SURFACE_ID,
    conversationId: String(message.chat.id),
    senderId: String(message.from.id),
    text,
    ...(attachments.length ? { attachments } : {}),
    replyTo: message.reply_to_message?.message_id !== undefined ? String(message.reply_to_message.message_id) : undefined,
    raw: update,
  };
}

export interface TelegramSendMessagePayload {
  readonly chat_id: string;
  readonly text: string;
  readonly parse_mode?: "HTML";
  readonly reply_markup?: {
    readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data: string }>>;
  };
}

export function telegramCallbackQueryId(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const id = (update as TelegramUpdate).callback_query?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** Map a gateway reply (or pairing challenge) to a Bot API sendMessage payload. */
export function surfaceReplyToTelegramSend(
  reply: SurfaceReply | PairingChallenge,
  chatId: string,
  options: TelegramRenderOptions = {},
): TelegramSendMessagePayload {
  if (isPairingChallenge(reply)) {
    return {
      chat_id: chatId,
      text: fitTelegramPlainText(`This chat is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${reply.code}`),
    };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 64);
    const prefix = `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${gateId}", run ${runId}):\n`;
    const suffix = `\n\n${approvalFallbackText(Boolean(actions))}`;
    return {
      chat_id: chatId,
      text: fitTelegramPlainText(`${prefix}${shown}`, suffix),
      ...(actions ? { reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: actions.approve },
          { text: "Reject", callback_data: actions.reject },
        ]],
      } } : {}),
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const { bound, unbound } = telegramPresentationActions(presentation);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < bound.length; index += 2) {
      keyboard.push(bound.slice(index, index + 2).map(({ label, binding }) => ({
        text: telegramButtonLabel(label),
        callback_data: binding,
      })));
    }
    return {
      chat_id: chatId,
      text: renderTelegramPresentation(presentation, unbound),
      parse_mode: "HTML",
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    };
  }
  return { chat_id: chatId, text: fitTelegramPlainText(reply.text) };
}

interface TelegramBoundAction {
  readonly label: string;
  readonly binding: string;
}

export interface TelegramPresentationContinuation {
  readonly filters?: readonly string[];
  readonly actions?: readonly string[];
}

interface TelegramActionCandidate {
  readonly action: SurfaceAction;
  readonly label: string;
  readonly source: "filter" | "drilldown" | "action";
  readonly index: number;
}

interface TelegramPreparedAction extends TelegramActionCandidate {
  readonly binding?: string;
  readonly priority: number;
}

function telegramPresentationActions(presentation: SurfacePresentation): {
  readonly bound: readonly TelegramBoundAction[];
  readonly unbound: readonly SurfaceAction[];
} {
  const candidates: TelegramActionCandidate[] = [];
  for (const filter of presentation.filters ?? []) {
    const action = filter.action;
    if (!action) continue;
    if (filter.options?.length && action.command.includes("{value}")) {
      for (const option of filter.options) {
        if (filter.selected === option.value) continue;
        candidates.push({
          action: { ...action, command: action.command.replaceAll("{value}", option.value) },
          label: `${filter.label}: ${option.label}`,
          source: "filter",
          index: candidates.length,
        });
      }
    } else if (!action.command.includes("{value}")) {
      candidates.push({ action, label: action.label, source: "filter", index: candidates.length });
    }
  }
  for (const action of presentation.drilldowns ?? []) {
    candidates.push({ action, label: action.label, source: "drilldown", index: candidates.length });
  }
  for (const action of presentation.actions ?? []) {
    candidates.push({ action, label: action.label, source: "action", index: candidates.length });
  }

  const byCommand = new Map<string, TelegramPreparedAction>();
  for (const candidate of candidates) {
    const command = candidate.action.command.trim();
    if (!bindSurfaceAction({ command })) continue;
    const essential = candidate.action.kind === "confirm"
      || candidate.action.kind === "page"
      || candidate.action.style === "primary"
      || candidate.action.style === "danger";
    const priority = essential
      ? 1_000
      : candidate.source === "drilldown"
        ? 300
        : candidate.source === "action"
          ? 250
          : 200;
    const prepared: TelegramPreparedAction = {
      ...candidate,
      action: { ...candidate.action, command, label: candidate.label },
      binding: bindSurfaceAction({ command }, TELEGRAM_CALLBACK_LIMIT_BYTES),
      priority,
    };
    const previous = byCommand.get(command);
    if (!previous || prepared.priority > previous.priority) byCommand.set(command, prepared);
  }

  const prepared = [...byCommand.values()];
  const bindable = prepared.filter((candidate) => candidate.binding);
  const manual = prepared.filter((candidate) => !candidate.binding).sort(compareTelegramActions);

  return {
    bound: bindable.sort((left, right) => left.index - right.index).map((candidate) => ({
      label: candidate.label,
      binding: candidate.binding!,
    })),
    unbound: manual.map((candidate) => candidate.action),
  };
}

function compareTelegramActions(left: TelegramPreparedAction, right: TelegramPreparedAction): number {
  return right.priority - left.priority || left.index - right.index;
}

export function renderTelegramPresentation(
  presentation: SurfacePresentation,
  unboundActions: readonly SurfaceAction[] = [],
  continuation: TelegramPresentationContinuation = {},
): string {
  const lines: string[] = [`<b>${telegramHtml(compactTelegramValue(presentation.title, 140))}</b>`];
  if (presentation.summary) lines.push(telegramHtml(compactTelegramValue(presentation.summary, 500)));

  if (presentation.work) {
    lines.push("", "<b>Status</b>", `<b>${telegramHtml(humanizeTelegramLabel(presentation.work.label, 100))}</b> · ${telegramHtml(humanizeTelegramLabel(presentation.work.state, 40))}`);
    if (presentation.work.detail) lines.push(telegramHtml(compactTelegramValue(presentation.work.detail, 300)));
  }

  if (presentation.kpis?.length) {
    lines.push("", "<b>Key metrics</b>");
    const metrics = presentation.kpis.map((kpi) => telegramFragment(
      `<b>${telegramHtml(humanizeTelegramLabel(kpi.label, 80))}</b> ${telegramHtml(compactTelegramValue(kpi.value, 80))}`,
      `${humanizeTelegramLabel(kpi.label, 80)} ${compactTelegramValue(kpi.value, 80)}`,
    ));
    lines.push(...groupTelegramFragments(metrics, 2));
    for (const kpi of presentation.kpis) {
      if (kpi.detail) lines.push(`<i>${telegramHtml(humanizeTelegramLabel(kpi.label, 60))}: ${telegramHtml(compactTelegramValue(kpi.detail, 180))}</i>`);
    }
  }

  for (const table of presentation.tables ?? []) {
    lines.push("");
    if (table.title) lines.push(`<b>${telegramHtml(humanizeTelegramLabel(table.title, 120))}</b>`);
    const hasDisplayableColumns = table.columns.length > 0;
    const availableRows = table.pagination?.totalRows === 0 || !hasDisplayableColumns ? [] : table.rows;
    const rows = availableRows.slice(0, TELEGRAM_MAX_TABLE_ROWS);
    const dense = rows.length > 4;
    if (table.columns.length === 2 && /^field$/i.test(table.columns[0] ?? "") && /^value$/i.test(table.columns[1] ?? "")) {
      for (const row of rows) {
        lines.push(`<b>${telegramHtml(humanizeTelegramLabel(row[0] ?? "", 80))}</b>: ${telegramHtml(telegramTableValue(row[1], dense ? 180 : 300))}`);
      }
    } else {
      const ordinalColumn = isTelegramOrdinalColumn(table.columns[0]);
      const primaryIndex = ordinalColumn && table.columns.length > 1 ? 1 : 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const ordinal = ordinalColumn ? compactTelegramValue(row[0] || String(rowIndex + 1), 12).replace(/\.$/, "") : String(rowIndex + 1);
        const primaryLabel = humanizeTelegramLabel(table.columns[primaryIndex] ?? "Item", dense ? 40 : 60);
        const primaryValue = telegramTableValue(row[primaryIndex], dense ? 100 : 140);
        lines.push(ordinalColumn
          ? `${telegramHtml(ordinal)}. <b>${telegramHtml(primaryValue)}</b>`
          : `${ordinal}. <b>${telegramHtml(primaryLabel)}</b>: ${telegramHtml(primaryValue)}`);
        const allDetails = table.columns.flatMap((column, columnIndex) => {
          if (columnIndex === primaryIndex || ordinalColumn && columnIndex === 0) return [];
          const value = compactTelegramValue(row[columnIndex] ?? "", dense ? 60 : 160);
          if (!value) return [];
          const label = humanizeTelegramLabel(column, dense ? 30 : 60);
          return [telegramFragment(
            `<b>${telegramHtml(label)}</b>: ${telegramHtml(value)}`,
            `${label}: ${value}`,
          )];
        });
        const details = dense ? allDetails.slice(0, 2) : allDetails;
        lines.push(...groupTelegramFragments(details, 2).map((line) => `• ${line}`));
        if (allDetails.length > details.length) lines.push(`• +${allDetails.length - details.length} more fields`);
      }
    }
    if (!hasDisplayableColumns && table.rows.length) lines.push("No displayable fields are available for this view.");
    else if (!rows.length) lines.push("No records are available for this view.");
    if (table.pagination) {
      const pages = Math.max(1, Math.ceil(table.pagination.totalRows / table.pagination.pageSize));
      lines.push(`Page ${table.pagination.page} of ${pages} · ${table.pagination.totalRows} total rows`);
      if (availableRows.length > rows.length) lines.push(`Showing ${rows.length} of ${availableRows.length} rows on this page`);
    } else if (availableRows.length > rows.length) {
      lines.push(`Showing ${rows.length} of ${availableRows.length} rows`);
    }
  }

  if (presentation.trends?.length) lines.push("", "<b>Trends</b>");
  for (const trend of presentation.trends ?? []) {
    lines.push(`<b>${telegramHtml(humanizeTelegramLabel(trend.label, 80))}</b>`);
    const points = trend.points.slice(0, TELEGRAM_MAX_TREND_POINTS).map((point) => {
      const label = humanizeTelegramLabel(point.label, 40);
      const value = `${point.value}${compactTelegramValue(trend.unit ?? "", 20)}`;
      return telegramFragment(`${telegramHtml(label)} ${telegramHtml(value)}`, `${label} ${value}`);
    });
    lines.push(...groupTelegramFragments(points, 4));
    if (trend.points.length > points.length) lines.push(`Showing ${points.length} of ${trend.points.length} points`);
  }

  if (presentation.filters?.length) {
    const selected = presentation.filters.filter((filter) => filter.selected).map((filter) => {
      const option = filter.options?.find((candidate) => candidate.value === filter.selected);
      return `<b>${telegramHtml(humanizeTelegramLabel(filter.label, 60))}</b>: ${telegramHtml(compactTelegramValue(option?.label ?? filter.selected ?? "", 100))}`;
    });
    lines.push("", "<b>Filters</b>", ...(selected.length ? selected : ["No filters selected."]));
  }
  if (unboundActions.length) {
    lines.push("", "<b>Other commands</b>");
    for (const action of unboundActions) {
      lines.push(`${telegramHtml(telegramActionLabel(action.label, action.command))}: <code>${telegramHtml(action.command.trim())}</code>`);
    }
  }
  if (continuation.filters?.length) {
    lines.push("", `<b>More filters</b>: ${telegramHtml(compactTelegramLabelList(continuation.filters))}`);
  }
  if (continuation.actions?.length) {
    lines.push(`<b>More actions</b>: ${telegramHtml(compactTelegramLabelList(continuation.actions))}`);
  }
  if (presentation.notice) lines.push("", "<b>Notice</b>", telegramHtml(compactTelegramValue(presentation.notice, 500)));
  if (presentation.privacy?.note) {
    const evidence = compactTelegramValue(presentation.privacy.note, 500).replace(/^evidence:\s*/i, "");
    lines.push("", "<b>Evidence &amp; privacy</b>", `<i>${telegramHtml(evidence)}</i>`);
  }

  return fitTelegramMessage(lines);
}

interface TelegramFragment {
  readonly html: string;
  readonly width: number;
}

function telegramFragment(html: string, plainText: string): TelegramFragment {
  return { html, width: [...plainText].length };
}

function groupTelegramFragments(fragments: readonly TelegramFragment[], maxItems: number): string[] {
  const lines: string[] = [];
  let current: TelegramFragment[] = [];
  let width = 0;
  for (const fragment of fragments) {
    const nextWidth = width + (current.length ? 3 : 0) + fragment.width;
    if (current.length && (current.length >= maxItems || nextWidth > TELEGRAM_GROUP_WIDTH)) {
      lines.push(current.map((item) => item.html).join(" · "));
      current = [];
      width = 0;
    }
    current.push(fragment);
    width += (current.length > 1 ? 3 : 0) + fragment.width;
  }
  if (current.length) lines.push(current.map((item) => item.html).join(" · "));
  return lines;
}

function isTelegramOrdinalColumn(column: string | undefined): boolean {
  return /^(?:no\.?|#|number|index)$/i.test(String(column ?? "").trim());
}

function telegramTableValue(value: string | undefined, maxLength: number): string {
  return compactTelegramValue(value ?? "", maxLength) || "Not provided";
}

function telegramActionLabel(label: string, command: string): string {
  const commandOnly = /^\/([a-z0-9_-]+)$/i.exec(label.trim());
  return humanizeTelegramLabel(commandOnly?.[1] ?? label, 80) || humanizeTelegramLabel(command.split(/\s+/, 1)[0]?.slice(1) ?? "Action", 80);
}

function telegramButtonLabel(label: string): string {
  const commandOnly = /^\/([a-z0-9_-]+)$/i.exec(label.trim());
  return humanizeTelegramLabel(commandOnly?.[1] ?? label, TELEGRAM_BUTTON_LABEL_LENGTH) || "Action";
}

function compactTelegramLabelList(labels: readonly string[]): string {
  const shown = labels.slice(0, 3);
  return `${shown.join(" · ")}${labels.length > shown.length ? ` · +${labels.length - shown.length} more` : ""}`;
}

function humanizeTelegramLabel(value: string, maxLength: number): string {
  const compact = compactTelegramValue(value, maxLength)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  const capitalized = `${compact[0].toUpperCase()}${compact.slice(1)}`;
  return compactTelegramValue(capitalized.replace(/\b(?:id|api|url|uri|kpi|sla|p\d+)\b/gi, (word) => word.toUpperCase()), maxLength);
}

function compactTelegramValue(value: unknown, maxLength: number): string {
  const compact = String(value ?? "")
    .replace(TELEGRAM_BOX_DRAWING, " ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...compact];
  return characters.length <= maxLength ? compact : `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function fitTelegramMessage(lines: readonly string[]): string {
  const kept: string[] = [];
  let length = 0;
  const marker = "<i>Report shortened for Telegram.</i>";
  for (const line of lines) {
    const addition = (kept.length ? 1 : 0) + line.length;
    if (length + addition <= TELEGRAM_MESSAGE_BUDGET) {
      kept.push(line);
      length += addition;
      continue;
    }
    while (kept.length && length + 1 + marker.length > TELEGRAM_MESSAGE_BUDGET) {
      const removed = kept.pop()!;
      length -= removed.length + (kept.length ? 1 : 0);
    }
    kept.push(marker);
    break;
  }
  return kept.join("\n");
}

function fitTelegramPlainText(value: string, suffix = ""): string {
  const marker = "\n\n[Message shortened for Telegram.]";
  const valueCharacters = [...value];
  const suffixCharacters = [...suffix];
  if (valueCharacters.length + suffixCharacters.length <= TELEGRAM_MESSAGE_LIMIT) return `${value}${suffix}`;
  const available = Math.max(0, TELEGRAM_MESSAGE_LIMIT - suffixCharacters.length - [...marker].length);
  return `${valueCharacters.slice(0, available).join("")}${marker}${suffix}`;
}

function telegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
