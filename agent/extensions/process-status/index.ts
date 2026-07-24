import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type ProcessStatusView, processStatusView } from "./status.ts";

const ENTRY_TYPE = "process-status";

export default function processStatus(pi: ExtensionAPI) {
  pi.registerEntryRenderer<ProcessStatusView>(
    ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      if (!entry.data) return undefined;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          `${theme.fg("accent", "[ps]")}\n${expanded ? entry.data.expanded : entry.data.collapsed}`,
          0,
          0,
        ),
      );
      return box;
    },
  );

  pi.registerCommand("ps", {
    description: "/ps: active; Ctrl+O: all tracked; /ps <id>: snapshot",
    handler: async (args, ctx) => {
      const view = processStatusView(pi, args.trim() || undefined);
      if (ctx.mode === "tui") pi.appendEntry(ENTRY_TYPE, view);
      else if (ctx.hasUI) ctx.ui.notify(view.collapsed, "info");
    },
  });
}
