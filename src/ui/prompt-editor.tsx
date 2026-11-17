import { useContext, useEffect, useRef, useState } from "react";
import {
  Node,
  mergeAttributes,
  nodeInputRule,
  nodePasteRule,
} from "@tiptap/core";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import {
  FilesIcon,
  TextTIcon,
  TargetIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { Badge } from "./components/ui/badge";
import { Button, Modal, Tip } from "./common";
import {
  defaultPrompts,
  promptVariables,
  promptSchema,
} from "../shared/settings";
import {
  promptDocument,
  serializePrompt,
  promptVariablePattern,
} from "../shared/prompt";
import { LocaleContext, useI18n, errorMessage } from "./i18n";
import { useScrollFade } from "./scroll-fade";
const labels = {
  title: "promptTitle",
  files: "promptFiles",
  scope: "promptScope",
} as const;
const help = {
  title: "promptTitleHelp",
  files: "promptFilesHelp",
  scope: "promptScopeHelp",
} as const;
type Variable = (typeof promptVariables)[number];
function VariableChip({ node, selected }: NodeViewProps) {
  const t = useI18n(),
    id = node.attrs.id as Variable,
    Icon = id === "files" ? FilesIcon : id === "scope" ? TargetIcon : TextTIcon;
  return (
    <NodeViewWrapper
      as="span"
      className="prompt-variable-node"
      data-prompt-variable={id}
      data-selected={selected}
      contentEditable={false}
    >
      <Tip text={t(help[id])}>
        <span tabIndex={0} aria-label={t(labels[id])}>
          <Badge variant="variable">
            <Icon data-icon="inline-start" />
            {t(labels[id])}
          </Badge>
        </span>
      </Tip>
    </NodeViewWrapper>
  );
}
const PromptVariable = Node.create({
  name: "promptVariable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      id: {
        default: "title",
        parseHTML: (e) => e.getAttribute("data-prompt-variable"),
        renderHTML: (attrs) => ({ "data-prompt-variable": attrs.id }),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-prompt-variable]",
        getAttrs: (e) =>
          promptVariables.includes(
            (e as HTMLElement).getAttribute("data-prompt-variable") as Variable,
          )
            ? null
            : false,
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), `{{${node.attrs.id}}}`];
  },
  renderText({ node }) {
    return `{{${node.attrs.id}}}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(VariableChip);
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: new RegExp(promptVariablePattern + "$"),
        type: this.type,
        getAttributes: (match) => ({ id: match[1] }),
      }),
    ];
  },
  addPasteRules() {
    return [
      nodePasteRule({
        find: new RegExp(promptVariablePattern, "g"),
        type: this.type,
        getAttributes: (match) => ({ id: match[1] }),
      }),
    ];
  },
});
export function PromptDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose(): void;
  onSave(prompt: string): Promise<void>;
}) {
  const t = useI18n(),
    language = useContext(LocaleContext);
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          italic: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          strike: false,
          heading: false,
          link: false,
          underline: false,
          trailingNode: false,
        }),
        PromptVariable,
      ],
      content: promptDocument(initial),
      editorProps: {
        attributes: {
          id: "recognition-prompt",
          role: "textbox",
          "aria-label": t("aiPrompt"),
          "aria-multiline": "true",
          class: "fade-scroll",
        },
      },
      onUpdate: ({ editor }) => setValue(serializePrompt(editor.getJSON())),
    },
    [],
  );
  const scroll = useRef<HTMLElement | null>(null);
  scroll.current = editor?.view.dom || null;
  useScrollFade(scroll);
  const invalid = !promptSchema.safeParse(value).success;
  useEffect(() => {
    editor?.view.dom.setAttribute("aria-invalid", String(invalid));
  }, [editor, invalid]);
  const insert = (id: Variable) => {
    if (!editor) return;
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor
      .chain()
      .focus()
      .insertContent({ type: "promptVariable", attrs: { id } })
      .run();
    editor.view.dispatch(closeHistory(editor.state.tr));
  };
  return (
    <Modal
      open
      title={t("aiPrompt")}
      onClose={onClose}
      className="prompt-config-modal"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={value === defaultPrompts[language]}
            onClick={() => {
              editor?.commands.setContent(
                promptDocument(defaultPrompts[language]),
              );
              setValue(defaultPrompts[language]);
            }}
          >
            {t("restoreDefault")}
          </Button>
          <span className="modal-status" role="status">
            {invalid ? t("invalidPrompt") : error}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || invalid || value === initial}
            onClick={() => {
              setBusy(true);
              onSave(value)
                .catch((e) => setError(errorMessage(e, t)))
                .finally(() => setBusy(false));
            }}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="prompt-config-body">
        <EditorContent editor={editor} className="prompt-editor" />
        <div
          className="prompt-variable-actions"
          role="group"
          aria-label={t("insertVariable")}
        >
          {promptVariables.map((id) => (
            <Tip key={id} text={t(help[id])}>
              <Button
                variant="secondary"
                size="sm"
                disabled={!editor}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => insert(id)}
              >
                <PlusIcon data-icon="inline-start" />
                {t(labels[id])}
              </Button>
            </Tip>
          ))}
        </div>
      </div>
    </Modal>
  );
}
