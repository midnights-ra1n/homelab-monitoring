import { useState } from "react";
import { api } from "../api";
import { Alert, Button, Field, Logo } from "../ui";

export function AuthPage({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (setup) await api.post("/api/auth/setup", form);
      else await api.post("/api/auth/login", { username: form.username, password: form.password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card" onSubmit={submit} noValidate>
        <div className="card-body form">
          <div className="brand" style={{ margin: 0, padding: 0 }}><Logo /><span className="brand-sub"><span>Monitoring</span></span></div>
          <div>
            <h1 style={{ fontSize: "var(--text-xl)", lineHeight: "28px" }}>{setup ? "Créer le compte administrateur" : "Se connecter"}</h1>
            <p className="small muted" style={{ marginTop: 4 }}>
              {setup ? "Premier démarrage : ce compte sera le seul administrateur." : "Accès réservé à l'administrateur."}
            </p>
          </div>
          {error && <Alert tone="danger" title={error} />}
          <Field label="Nom d'utilisateur" htmlFor="user">
            <input id="user" className="input" autoComplete="username" value={form.username} onChange={set("username")} required />
          </Field>
          <Field label="Mot de passe" htmlFor="pw" hint={setup ? "12 caractères minimum" : undefined}>
            <input id="pw" className="input" type="password" autoComplete={setup ? "new-password" : "current-password"} value={form.password} onChange={set("password")} required />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={busy}>{setup ? "Créer le compte" : "Se connecter"}</Button>
        </div>
      </form>
    </div>
  );
}
