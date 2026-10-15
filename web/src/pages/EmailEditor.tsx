import { useEffect, useState } from "react";
import { api } from "../api";
import { BlockEditor, type BlockType } from "../blocks";
import { Alert, Button, Card, CardBody, CardHeader, FORM_ACTIONS, Field, Segmented, inputClass, textareaClass } from "../ui";

interface EmailBlock { id: string; type: "header" | "summary" | "events" | "text" | "button" | "divider" | "footer"; text?: string; label?: string; url?: string }

const TYPES: Record<EmailBlock["type"], BlockType<EmailBlock>> = {
  header: { label: "En-tête", description: "Titre du message", create: () => ({ type: "header", text: "{titre}" }) },
  summary: { label: "Résumé", description: "Compteurs pannes / avertissements", create: () => ({ type: "summary" }) },
  events: { label: "Événements", description: "Liste des changements d'état", create: () => ({ type: "events" }) },
  text: { label: "Texte", description: "Paragraphe libre", create: () => ({ type: "text", text: "" }) },
  button: { label: "Bouton", description: "Lien vers le tableau de bord", create: () => ({ type: "button", label: "Ouvrir le tableau de bord", url: "" }) },
  divider: { label: "Séparateur", description: "Trait horizontal", create: () => ({ type: "divider" }) },
  footer: { label: "Pied de page", description: "Petit texte en bas", create: () => ({ type: "footer", text: "" }) },
};

const PLACEHOLDERS = "{titre}, {date}, {pannes}, {avertissements}, {changements}";

export function EmailEditor({ draft, setDraft, save, busy }: {
  draft: Record<string, string>; setDraft: (s: Record<string, string>) => void; save: (section: string, keys: string[]) => void; busy?: string;
}) {
  const mode = draft.email_mode === "html" ? "html" : "blocks";
  const blocks: EmailBlock[] = (() => { try { return JSON.parse(draft.email_blocks || "[]"); } catch { return []; } })();
  const setBlocks = (b: EmailBlock[]) => setDraft({ ...draft, email_blocks: JSON.stringify(b) });
  const [preview, setPreview] = useState<{ subject: string; html: string }>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const t = setTimeout(() => {
      api.post<{ subject: string; html: string }>("/api/settings/preview-email", {
        subject: draft.email_subject ?? "", mode, html: draft.email_html ?? "", blocks: draft.email_blocks ?? "",
      }).then((p) => { setPreview(p); setErr(undefined); }, (e) => setErr(e.message));
    }, 400);
    return () => clearTimeout(t);
  }, [draft.email_subject, draft.email_html, draft.email_blocks, mode]);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
      <Card>
        <CardBody className="grid gap-5">
          <Segmented label="Mode d'édition" value={mode} onChange={(v) => setDraft({ ...draft, email_mode: v })} options={[["blocks", "Éditeur visuel"], ["html", "HTML avancé"]]} />
          <Field label="Objet" htmlFor="s-subj" hint="Syntaxe Go template : .Down, .Warnings, .Events…">
            <input id="s-subj" className={`${inputClass} font-mono`} value={draft.email_subject ?? ""} onChange={(e) => setDraft({ ...draft, email_subject: e.target.value })} />
          </Field>
          {err && <Alert kind="error">{err}</Alert>}
          {mode === "blocks" ? (
            <BlockEditor blocks={blocks} onChange={setBlocks} types={TYPES}
              title={(b) => b.text || b.label || TYPES[b.type].description}
              renderFields={(b, up) => (
                <>
                  {(b.type === "header" || b.type === "text" || b.type === "footer") && (
                    <Field label="Texte" hint={`Variables : ${PLACEHOLDERS}`}>
                      {b.type === "text"
                        ? <textarea className={textareaClass} value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />
                        : <input className={inputClass} value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />}
                    </Field>
                  )}
                  {b.type === "button" && (
                    <>
                      <Field label="Libellé"><input className={inputClass} value={b.label ?? ""} onChange={(e) => up({ label: e.target.value })} /></Field>
                      <Field label="Lien (facultatif)" hint="Vide : adresse du tableau de bord (HLM_PUBLIC_URL)"><input className={`${inputClass} font-mono`} placeholder="https://" value={b.url ?? ""} onChange={(e) => up({ url: e.target.value })} /></Field>
                    </>
                  )}
                  {(b.type === "summary" || b.type === "events" || b.type === "divider") && <p className="text-sm text-meta">{TYPES[b.type].description}. Aucun réglage.</p>}
                </>
              )} />
          ) : (
            <Field label="Corps HTML" htmlFor="s-html" hint="Variables : .Title, .Date, .URL, .Down, .Warnings, .Events (.Name, .Kind, .FromLabel, .ToLabel, .Color, .Time, .Message)">
              <textarea id="s-html" className={`${textareaClass} min-h-64 font-mono text-xs!`} spellCheck={false} value={draft.email_html ?? ""} onChange={(e) => setDraft({ ...draft, email_html: e.target.value })} />
            </Field>
          )}
          <div className={FORM_ACTIONS}>
            <Button variant="ghost" onClick={() => setDraft({ ...draft, email_subject: "", email_html: "", email_blocks: "" })}>Rétablir le modèle par défaut</Button>
            <Button loading={busy === "tpl"} onClick={() => save("tpl", ["email_mode", "email_subject", "email_html", "email_blocks"])}>Enregistrer le modèle</Button>
          </div>
        </CardBody>
      </Card>
      <Card className="overflow-hidden xl:sticky xl:top-6">
        <CardHeader overline="Aperçu" title={preview?.subject ?? "…"} />
        {/* sandbox without allow-scripts: the template cannot run code in the dashboard. */}
        {preview && <iframe title="Aperçu de l'e-mail" sandbox="" srcDoc={preview.html} className="block h-[32rem] w-full border-t border-line bg-white" />}
      </Card>
    </div>
  );
}
