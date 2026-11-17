import { useState } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { Button, IconButton } from "./common";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./components/ui/popover";
import { useI18n } from "./i18n";
export function TagEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange(tags: string[]): void;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(false),
    [value, setValue] = useState("");
  const add = () => {
    const tag = value.trim();
    if (tag) {
      onChange([...new Set([...tags, tag])]);
      setValue("");
      setOpen(false);
    }
  };
  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tag}
          <IconButton
            label={t("remove") + " " + tag}
            onClick={() => onChange(tags.filter((v) => v !== tag))}
          >
            <XIcon />
          </IconButton>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm">
            <PlusIcon data-icon="inline-start" />
            {t("add")}
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex gap-2">
            <Input
              aria-label={t("domains")}
              value={value}
              maxLength={253}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button disabled={!value.trim()} onClick={add}>
              {t("add")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
