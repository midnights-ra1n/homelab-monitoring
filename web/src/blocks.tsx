import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button, IconButton, cn } from "./ui";

export interface Block { id: string; type: string }

export interface BlockType<T extends Block> { label: string; description: string; create: () => Omit<T, "id"> }

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Generic block list editor: add from a palette, reorder by drag and drop or with the
 * arrow buttons (keyboard-accessible), select a block to edit it, delete it.
 */
export function BlockEditor<T extends Block>({ blocks, onChange, types, renderFields, title }: {
  blocks: T[];
  onChange: (b: T[]) => void;
  types: Record<string, BlockType<T>>;
  renderFields: (b: T, update: (patch: Partial<T>) => void) => ReactNode;
  title: (b: T) => string;
}) {
  const [selected, setSelected] = useState<string | undefined>(blocks[0]?.id);
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState<string>();
  const [overId, setOverId] = useState<string>();

  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length) return;
    const n = [...blocks];
    const [b] = n.splice(from, 1);
    n.splice(to, 0, b);
    onChange(n);
  };
  const update = (id: string) => (patch: Partial<T>) => onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const add = (type: string) => {
    const b = { ...types[type].create(), id: newId(), type } as T;
    const at = blocks.findIndex((x) => x.id === selected);
    const n = [...blocks];
    n.splice(at < 0 ? n.length : at + 1, 0, b);
    onChange(n);
    setSelected(b.id);
    setAdding(false);
  };

  return (
    <div className="grid gap-3">
      <ol className="grid gap-2" aria-label="Blocs">
        {blocks.map((b, i) => {
          const isSel = b.id === selected;
          return (
            <li key={b.id}
              className={cn("rounded-xl border bg-page transition-colors", isSel ? "border-line-accent" : "border-line-subtle", overId === b.id && dragId !== b.id && "shadow-[0_-2px_0_var(--mm-accent)]")}
              draggable
              onDragStart={(e) => { setDragId(b.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); setOverId(b.id); }}
              onDragLeave={() => setOverId(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                const from = blocks.findIndex((x) => x.id === dragId);
                if (from >= 0) move(from, i);
                setDragId(undefined); setOverId(undefined);
              }}
              onDragEnd={() => { setDragId(undefined); setOverId(undefined); }}>
              <div className="flex items-center gap-0.5 py-1 pl-3 pr-1">
                <GripVertical size={16} className="shrink-0 cursor-grab text-meta" aria-hidden />
                <button type="button" className="flex min-w-0 flex-1 flex-col items-start rounded-lg px-2 py-1.5 text-left hover:bg-hover" aria-expanded={isSel} onClick={() => setSelected(isSel ? undefined : b.id)}>
                  <span className="mm-label-caps">{types[b.type]?.label ?? b.type}</span>
                  <span className="w-full truncate text-sm text-h1">{title(b)}</span>
                </button>
                <IconButton label="Monter" icon={<ArrowUp size={15} />} disabled={i === 0} onClick={() => move(i, i - 1)} />
                <IconButton label="Descendre" icon={<ArrowDown size={15} />} disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)} />
                <IconButton label="Supprimer le bloc" icon={<Trash2 size={15} />} onClick={() => onChange(blocks.filter((x) => x.id !== b.id))} />
              </div>
              {isSel && <div className="grid gap-4 border-t border-line-subtle p-4">{renderFields(b, update(b.id))}</div>}
            </li>
          );
        })}
      </ol>
      {adding ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
          {Object.entries(types).map(([type, t]) => (
            <button key={type} type="button" className="flex flex-col items-start gap-0.5 rounded-xl border border-dashed border-line-strong bg-box p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft" onClick={() => add(type)}>
              <span className="text-sm font-medium text-h1">{t.label}</span><span className="text-xs text-meta">{t.description}</span>
            </button>
          ))}
          <Button variant="ghost" size="sm" className="self-center" onClick={() => setAdding(false)}>Annuler</Button>
        </div>
      ) : (
        <Button variant="secondary" className="w-fit" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Ajouter un bloc</Button>
      )}
    </div>
  );
}
