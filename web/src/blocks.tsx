import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "./ui";

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
    <div className="block-editor">
      <ol className="block-list" aria-label="Blocs">
        {blocks.map((b, i) => {
          const isSel = b.id === selected;
          return (
            <li key={b.id}
              className={`block-item${isSel ? " selected" : ""}${overId === b.id && dragId !== b.id ? " drop-target" : ""}`}
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
              <div className="block-head">
                <GripVertical size={16} className="tertiary" aria-hidden style={{ cursor: "grab", flex: "none" }} />
                <button type="button" className="block-title" aria-expanded={isSel} onClick={() => setSelected(isSel ? undefined : b.id)}>
                  <span className="xs tertiary">{types[b.type]?.label ?? b.type}</span>
                  <span className="ellipsis">{title(b)}</span>
                </button>
                <IconButton label="Monter" icon={<ArrowUp />} className="sm" disabled={i === 0} onClick={() => move(i, i - 1)} />
                <IconButton label="Descendre" icon={<ArrowDown />} className="sm" disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)} />
                <IconButton label="Supprimer le bloc" icon={<Trash2 />} className="sm" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))} />
              </div>
              {isSel && <div className="block-fields form">{renderFields(b, update(b.id))}</div>}
            </li>
          );
        })}
      </ol>
      {adding ? (
        <div className="block-palette">
          {Object.entries(types).map(([type, t]) => (
            <button key={type} type="button" className="palette-item" onClick={() => add(type)}>
              <strong>{t.label}</strong><span className="xs muted">{t.description}</span>
            </button>
          ))}
          <Button size="sm" onClick={() => setAdding(false)}>Annuler</Button>
        </div>
      ) : (
        <Button icon={<Plus />} onClick={() => setAdding(true)}>Ajouter un bloc</Button>
      )}
    </div>
  );
}
