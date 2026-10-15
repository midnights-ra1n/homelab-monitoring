import { useState } from "react";
import { api } from "../api";
import { LogIn, UserPlus } from "lucide-react";
import { Alert, Button, Field, Logo, inputClass } from "../ui";

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
    <div className="flex min-h-screen flex-col items-center justify-center px-5 py-16">
      <div className="w-full max-w-md">
        <div className="mb-10 flex justify-center"><Logo /></div>
        <div className="rounded-3xl border border-line-subtle bg-box p-7 sm:p-8">
          <h1 className="text-3xl font-bold tracking-tight text-h1">
            {setup ? <>Bienvenue au <span className="text-accent-text">labo</span></> : <>Bon retour <span className="text-accent-text">au labo</span></>}
          </h1>
          <p className="mb-8 mt-3 text-sm leading-relaxed text-body">
            {setup ? "Premier démarrage : crée le compte administrateur, ce sera le seul." : "Connecte-toi pour superviser ton homelab."}
          </p>
          <form className="grid gap-5" onSubmit={submit} noValidate>
            {error && <Alert kind="error">{error}</Alert>}
            <Field label="Identifiant" htmlFor="user" required>
              <input id="user" className={inputClass} autoComplete="username" autoFocus value={form.username} onChange={set("username")} required />
            </Field>
            <Field label="Mot de passe" htmlFor="pw" hint={setup ? "12 caractères minimum" : undefined} required>
              <input id="pw" className={inputClass} type="password" autoComplete={setup ? "new-password" : "current-password"} value={form.password} onChange={set("password")} required />
            </Field>
            <Button type="submit" className="mt-2 w-full" loading={busy} icon={setup ? <UserPlus size={16} /> : <LogIn size={16} />}>
              {setup ? "Créer le compte et commencer" : "Se connecter"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
