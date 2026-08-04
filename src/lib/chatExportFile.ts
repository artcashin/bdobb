import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { chatToMarkdown, exportFilename, type ExportOptions } from "./chatExport";
import type { AgentCall, ChatMessage } from "./agent/types";
import { logError } from "./logger";

/**
 * Renders the conversation and writes it wherever the user chooses.
 *
 * Kept separate from chatToMarkdown so the document generation stays a pure,
 * fully testable function — this module is only the Tauri glue.
 *
 * Returns the written path, or null if the user cancelled the dialog.
 */
export async function saveChatExport(
  messages: ChatMessage[],
  calls: AgentCall[],
  opts: ExportOptions
): Promise<string | null> {
  const markdown = chatToMarkdown(messages, calls, opts);

  const path = await save({
    defaultPath: exportFilename(opts.exportedAt),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  // Cancelling is a normal outcome, not a failure.
  if (!path) return null;

  try {
    // No baseDir: the dialog returns an absolute path, and the fs scope is
    // extended to cover the file the user picked.
    await writeTextFile(path, markdown);
    return path;
  } catch (e) {
    logError(`chat export: failed to write ${path}: ${String(e)}`);
    throw e;
  }
}
