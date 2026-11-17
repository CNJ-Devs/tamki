import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVerticalIcon, XIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { LibraryState, Series } from "../shared/model";
import { Button, IconButton, Modal, FormField, TextTip, Fade } from "./common";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { useI18n, errorMessage } from "./i18n";
function Member({
  id,
  title,
  remove,
}: {
  id: string;
  title: string;
  remove(): void;
}) {
  const t = useI18n(),
    drag = useSortable({ id });
  return (
    <div
      className="series-member"
      ref={drag.setNodeRef}
      style={{
        transform: CSS.Transform.toString(drag.transform),
        transition: drag.transition,
      }}
      {...drag.attributes}
      {...drag.listeners}
    >
      <span aria-label={t("seriesOrder")}>
        <DotsSixVerticalIcon />
      </span>
      <TextTip>{title}</TextTip>
      <IconButton
        label={t("remove")}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={remove}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}
export function SeriesEditor({
  state,
  initial,
  workId,
  onClose,
}: {
  state: LibraryState;
  initial?: Series;
  workId?: string;
  onClose(): void;
}) {
  const t = useI18n();
  const [name, setName] = useState(initial?.name || ""),
    [ids, setIds] = useState(initial?.workIds || (workId ? [workId] : [])),
    [busy, setBusy] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const occupied = new Set(
    (state.series || [])
      .filter((s) => s.id !== initial?.id)
      .flatMap((s) => s.workIds),
  );
  return (
    <>
      <Modal
        open
        title={t(initial ? "manageSeries" : "newSeries")}
        onClose={onClose}
        className="series-modal"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim() || !ids.length}
              onClick={() => {
                setBusy(true);
                void window.tamki
                  .library("save-series", {
                    id: initial?.id,
                    name,
                    workIds: ids,
                  })
                  .then(onClose)
                  .catch((e) => toast.error(errorMessage(e, t)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <Fade className="modal-body series-editor-body">
          <FormField label={t("seriesName")} htmlFor="series-name">
            <Input
              id="series-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <div className="series-member-scroll">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (over && active.id !== over.id)
                  setIds((old) =>
                    arrayMove(
                      old,
                      old.indexOf(String(active.id)),
                      old.indexOf(String(over.id)),
                    ),
                  );
              }}
            >
              <SortableContext
                items={ids}
                strategy={verticalListSortingStrategy}
              >
                {ids.map((id) => (
                  <Member
                    key={id}
                    id={id}
                    title={state.works.find((w) => w.id === id)?.title || id}
                    remove={() => setIds((old) => old.filter((x) => x !== id))}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <h3>{t("seriesAvailable")}</h3>
            {state.works
              .filter((w) => !occupied.has(w.id) && !ids.includes(w.id))
              .map((w) => (
                <label key={w.id} className="folder-row">
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => setIds((old) => [...old, w.id])}
                  />
                  <TextTip>{w.title}</TextTip>
                </label>
              ))}
          </div>
        </Fade>
      </Modal>
    </>
  );
}
