import type {
  AgentToolResult,
  MessageRenderer,
  Theme,
  ThemeColor,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Clock, Effect, Option, Schema } from "effect";
import { sanitizeInline, sanitizeMultiline } from "../../lib/text.ts";
import type { RunningTerminalNotification } from "./notifications.ts";
import { type TerminalMetadata, terminalResultFields } from "./terminal.ts";

const { resolve } = process.getBuiltinModule("node:path");

const START_COMMAND_ROWS = 5;

// Views are stored in message and tool-result details so resumed sessions
// render without the live terminal manager. Older entries fail decoding and
// keep Pi's default rendering.
const TerminalView = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  state: Schema.Literals(["running", "done", "failed", "killed"]),
  exitCode: Schema.NullOr(Schema.Finite),
  signal: Schema.NullOr(Schema.String),
  elapsedMs: Schema.Finite,
});

export type TerminalView = typeof TerminalView.Type;

const NotificationView = Schema.Struct({
  terminalId: Schema.String,
  message: Schema.String,
});

export type NotificationView = typeof NotificationView.Type;

const TerminalList = Schema.Struct({ terminals: Schema.Array(TerminalView) });

const decodeTerminalList = Schema.decodeUnknownOption(TerminalList);

const decodeResultsMessage = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.String, details: TerminalList }),
);

const decodeTerminal = Schema.decodeUnknownOption(Schema.Struct({ terminal: TerminalView }));

const decodeNotifications = Schema.decodeUnknownOption(
  Schema.Struct({ notifications: Schema.Array(NotificationView) }),
);

const decodeStarted = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));

const stateStyles: Record<TerminalView["state"], { icon: string; color: ThemeColor }> = {
  running: { icon: "●", color: "accent" },
  done: { icon: "✓", color: "success" },
  failed: { icon: "✗", color: "error" },
  killed: { icon: "■", color: "warning" },
};

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

type ToolResult = AgentToolResult<unknown>;

export function elapsedMs(snapshot: TerminalMetadata): number {
  const end =
    snapshot.state === "running" ? Effect.runSync(Clock.currentTimeMillis) : snapshot.settledAt;

  return Math.max(0, end - snapshot.createdAt);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function terminalView(snapshot: TerminalMetadata): TerminalView {
  const fields = terminalResultFields(snapshot);

  return {
    id: sanitizeInline(snapshot.id),
    command: sanitizeMultiline(snapshot.command),
    state: snapshot.state,
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    elapsedMs: elapsedMs(snapshot),
  };
}

export function notificationView(notification: RunningTerminalNotification): NotificationView {
  return {
    terminalId: sanitizeInline(notification.terminalId),
    message: sanitizeMultiline(notification.message),
  };
}

// Wraps text to the render width and, when maxRows is set, hides the rest
// behind Pi's expand toggle.
class WrappedRows implements Component {
  private readonly text: string;
  private readonly maxRows: number | undefined;
  private readonly indent: string;
  private readonly theme: Theme;
  constructor(text: string, maxRows: number | undefined, theme: Theme, indent = "") {
    this.text = text;
    this.maxRows = maxRows;
    this.theme = theme;
    this.indent = indent;
  }
  render(width: number): string[] {
    const rows = wrapTextWithAnsi(this.text, Math.max(1, width - visibleWidth(this.indent))).map(
      (row) => this.indent + row,
    );

    if (this.maxRows === undefined || rows.length <= this.maxRows) return rows;

    const hidden = rows.length - this.maxRows;
    const hint = `${this.indent}… ${hidden} more ${hidden === 1 ? "line" : "lines"}, `;

    return [
      ...rows.slice(0, this.maxRows),
      truncateToWidth(
        this.theme.fg("muted", hint) + keyHint("app.tools.expand", "to expand"),
        width,
      ),
    ];
  }
  invalidate() {}
}

function contentText(content: ToolResult["content"]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function outputText(text: string, theme: Theme): Component {
  return new Text(
    text
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n"),
    0,
    0,
  );
}

function terminalBlock(view: TerminalView, expanded: boolean, theme: Theme): Component {
  const style = stateStyles[view.state];
  const facts: string[] = [];

  if (view.state !== "running") {
    if (view.signal !== null) facts.push(view.signal);
    else if (view.exitCode !== null) facts.push(`exit ${view.exitCode}`);
  }

  facts.push(formatDuration(view.elapsedMs));

  const heading = theme.fg(style.color, `${style.icon} ${theme.bold(view.id)} ${view.state}`);
  const block = new Container();
  block.addChild(new Text(`${heading}${theme.fg("muted", ` · ${facts.join(" · ")}`)}`, 0, 0));
  block.addChild(new WrappedRows(view.command, expanded ? undefined : 1, theme, "  "));

  return block;
}

function terminalBlocks(views: readonly TerminalView[], expanded: boolean, theme: Theme) {
  const blocks = new Container();

  for (const [index, view] of views.entries()) {
    if (index > 0) blocks.addChild(new Spacer(1));
    blocks.addChild(terminalBlock(view, expanded, theme));
  }

  return blocks;
}

function toolHeading(name: string, subject: string, theme: Theme): string {
  return `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", subject)}`;
}

// Failed calls show Pi's error text, and results without a view, such as
// those stored before views existed, show the text the agent received.
function renderToolResult<T>(
  result: ToolResult,
  context: RenderContext,
  theme: Theme,
  view: Option.Option<T>,
  render: (value: T, text: string) => Component,
): Component {
  const text = contentText(result.content);

  if (context.isError) return new Text(theme.fg("error", text), 0, 0);

  return Option.match(view, {
    onNone: () => outputText(text, theme),
    onSome: (value) => render(value, text),
  });
}

export function renderStartCall(
  args: { command: string; working_dir?: string },
  theme: Theme,
  context: RenderContext,
): Component {
  const call = new Container();
  call.addChild(
    new WrappedRows(
      `${theme.fg("toolTitle", theme.bold("bg_start"))} ${sanitizeMultiline(args.command)}`,
      context.expanded ? undefined : START_COMMAND_ROWS,
      theme,
    ),
  );

  if (args.working_dir !== undefined) {
    const cwd = resolve(context.cwd, args.working_dir);

    if (cwd !== context.cwd)
      call.addChild(new Text(theme.fg("muted", `in ${sanitizeInline(cwd)}`), 0, 0));
  }

  return call;
}

export function renderStartResult(
  result: ToolResult,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  return renderToolResult(
    result,
    context,
    theme,
    decodeStarted(result.details),
    ({ id }) =>
      new Text(`${theme.fg("success", "started")} ${theme.fg("accent", theme.bold(id))}`, 0, 0),
  );
}

export function renderStatusCall(args: { id: string }, theme: Theme): Component {
  return new Text(toolHeading("bg_status", sanitizeInline(args.id), theme), 0, 0);
}

export function renderStatusResult(
  result: ToolResult,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  return renderToolResult(
    result,
    context,
    theme,
    decodeTerminal(result.details),
    ({ terminal }, text) => {
      const block = terminalBlock(terminal, context.expanded, theme);

      if (!context.expanded) return block;

      const report = new Container();
      report.addChild(block);
      report.addChild(new Spacer(1));
      report.addChild(outputText(text, theme));

      return report;
    },
  );
}

export function renderKillCall(args: { ids: readonly string[] }, theme: Theme): Component {
  return new Text(toolHeading("bg_kill", args.ids.map(sanitizeInline).join(", "), theme), 0, 0);
}

export function renderKillResult(
  result: ToolResult,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  return renderToolResult(
    result,
    context,
    theme,
    decodeTerminalList(result.details),
    ({ terminals }) => terminalBlocks(terminals, context.expanded, theme),
  );
}

export const renderResultsMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  const decoded = decodeResultsMessage(message);

  if (Option.isNone(decoded)) return undefined;

  const { content, details } = decoded.value;
  const succeeded = details.terminals.every((view) => view.state === "done");
  const background = succeeded ? "toolSuccessBg" : "toolErrorBg";
  const box = new Box(outputPad, 1, (text) => theme.bg(background, text));

  box.addChild(terminalBlocks(details.terminals, expanded, theme));

  if (expanded) {
    box.addChild(new Spacer(1));
    box.addChild(outputText(content, theme));
  }

  return box;
};

export const renderNotificationMessage: MessageRenderer = (
  message,
  { expanded, outputPad },
  theme,
) => {
  const details = decodeNotifications(message.details);

  if (Option.isNone(details)) return undefined;
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));

  for (const notification of details.value.notifications) {
    const label = theme.fg("accent", `◆ ${theme.bold(notification.terminalId)}`);
    box.addChild(
      new WrappedRows(`${label} ${notification.message}`, expanded ? undefined : 1, theme),
    );
  }

  return box;
};
