import { useEffect, useState } from "react";
import { api } from "../api";
import { BlockEditor, type BlockType } from "../blocks";
import { Button, Field, Segmented } from "../ui";

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
    <div className="form">
      <Field label="Mode"><Segmented label="Mode d'édition" value={mode} onChange={(v) => setDraft({ ...draft, email_mode: v })} options={[["blocks", "Éditeur visuel"], ["html", "HTML avancé"]]} /></Field>
      <Field label="Objet" htmlFor="s-subj" hint="Syntaxe Go template : .Down, .Warnings, .Events…">
        <input id="s-subj" className="input mono" value={draft.email_subject ?? ""} onChange={(e) => setDraft({ ...draft, email_subject: e.target.value })} />
      </Field>
      {err && <span className="small" style={{ color: "var(--danger-fg)" }} role="alert">{err}</span>}
      <div className="editor-layout" style={{ gridTemplateColumns: "1fr" }}>
        {mode === "blocks" ? (
          <BlockEditor blocks={blocks} onChange={setBlocks} types={TYPES}
            title={(b) => b.text || b.label || TYPES[b.type].description}
            renderFields={(b, up) => (
              <>
                {(b.type === "header" || b.type === "text" || b.type === "footer") && (
                  <Field label="Texte" hint={`Variables : ${PLACEHOLDERS}`}>
                    {b.type === "text"
                      ? <textarea className="textarea" style={{ minHeight: 100, fontFamily: "var(--font-sans)" }} value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />
                      : <input className="input" value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />}
                  </Field>
                )}
                {b.type === "button" && (
                  <>
                    <Field label="Libellé"><input className="input" value={b.label ?? ""} onChange={(e) => up({ label: e.target.value })} /></Field>
                    <Field label="Lien (facultatif)" hint="Vide : adresse du tableau de bord (HLM_PUBLIC_URL)"><input className="input mono" placeholder="https://" value={b.url ?? ""} onChange={(e) => up({ url: e.target.value })} /></Field>
                  </>
                )}
                {(b.type === "summary" || b.type === "events" || b.type === "divider") && <p className="small muted">{TYPES[b.type].description}. Aucun réglage.</p>}
              </>
            )} />
        ) : (
          <Field label="Corps HTML" htmlFor="s-html" hint="Variables : .Title, .Date, .URL, .Down, .Warnings, .Events (.Name, .Kind, .FromLabel, .ToLabel, .Color, .Time, .Message)">
            <textarea id="s-html" className="textarea" style={{ minHeight: 260 }} spellCheck={false} value={draft.email_html ?? ""} onChange={(e) => setDraft({ ...draft, email_html: e.target.value })} />
          </Field>
        )}
        {preview && (
          <Field label={`Aperçu : ${preview.subject}`}>
            {/* sandbox without allow-scripts: the template cannot run code in the dashboard. */}
            <iframe title="Aperçu de l'e-mail" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 420, border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "#fff" }} />
          </Field>
        )}
      </div>
      <div className="row">
        <Button variant="primary" loading={busy === "tpl"} onClick={() => save("tpl", ["email_mode", "email_subject", "email_html", "email_blocks"])}>Enregistrer le modèle</Button>
        <Button onClick={() => setDraft({ ...draft, email_subject: "", email_html: "", email_blocks: "" })}>Rétablir le modèle par défaut</Button>
      </div>
    </div>
  );
}
