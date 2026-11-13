import type { JSONContent } from "@tiptap/core";
import { promptVariables } from "./settings";
export const promptVariablePattern = "\\{\\{(title|files|scope)\\}\\}";
export function promptDocument(template: string): JSONContent {
  return {
    type: "doc",
    content: template.split("\n").map((line) => {
      const content: JSONContent[] = [];
      let from = 0;
      for (const match of line.matchAll(
        new RegExp(promptVariablePattern, "g"),
      )) {
        if (match.index! > from)
          content.push({ type: "text", text: line.slice(from, match.index) });
        content.push({ type: "promptVariable", attrs: { id: match[1] } });
        from = match.index! + match[0].length;
      }
      if (from < line.length)
        content.push({ type: "text", text: line.slice(from) });
      return { type: "paragraph", content };
    }),
  };
}
export function serializePrompt(doc: JSONContent): string {
  const inline = (node: JSONContent): string =>
    node.type === "promptVariable"
      ? promptVariables.includes(node.attrs?.id)
        ? `{{${node.attrs!.id}}}`
        : ""
      : node.type === "text"
        ? node.text || ""
        : node.type === "hardBreak"
          ? "\n"
          : (node.content || []).map(inline).join("");
  return (doc.content || []).map(inline).join("\n");
}
