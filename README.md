# Homelab Monitoring

Supervision légère d'un homelab : un **hub** (Go + SQLite + interface React, livré en conteneur Docker) et un **agent** (binaire Rust statique pour Debian) installé sur chaque machine.

- Hôtes : CPU, mémoire, swap, disques, températures, bande passante, charge, avec historiques.
- Mises à jour système (Debian / apt) : paquets en attente, mises à jour de sécurité, redémarrage requis, relevés sans privilèges toutes les 6 heures.
- Sondes : HTTP(S) (codes attendus, mot-clé, case « Vérifier le certificat SSL » avec jours restants), port TCP, DNS (type d'enregistrement, serveur, réponse attendue), certificat SSL seul.
- Avertissement e-mail avant l'expiration d'un certificat (délai réglable par sonde, par exemple 3 jours), envoyé une seule fois par certificat.
- États façon Statuspage : opérationnel, performances dégradées, maintenance, panne partielle, panne majeure.
- Alertes e-mail SMTP **regroupées** : tous les changements d'état d'une fenêtre (60 s par défaut) partent dans un seul message. Modèle HTML entièrement personnalisable avec aperçu.
- Santé des disques (SMART) : état lisible (bon état, à surveiller, à remplacer, défaillant), score, disque utilisable ou non, durée restante estimée, alerte e-mail si un disque se dégrade.
- Page de statut publique (`/status`) composée par blocs (en-tête, état global, services avec historique 30/60/90 jours, disponibilité, graphique de latence, texte), réordonnables par glisser-déposer, avec aperçu en direct.
- E-mail d'alerte composé par blocs (en-tête, résumé, événements, texte, bouton, pied de page) ou en HTML avancé.
- Rapport mensuel (disponibilité moyenne, latence, jours d'incident, hôtes, certificats, mises à jour, disques), consultable, imprimable et envoyé le 1er du mois.
- API REST `/api/v1` activable, jetons à scopes et date d'expiration : voir [docs/API.md](docs/API.md).
- Tableau de bord personnalisable, thèmes Midnights Classic et Midnights Mint (clair/sombre), PWA installable.
- Rétention configurable, nettoyage et compactage de la base, import/export JSON des réglages, sondes et métriques.

## Démarrer le hub

```sh
docker compose up -d            # voir docker-compose.yml
```

Ouvrez l'interface et créez le compte administrateur. Tant qu'il n'existe pas, la première personne qui ouvre l'interface peut le créer : faites-le juste après le démarrage, avant d'exposer le hub.

| Variable | Rôle |
|---|---|
| `HLM_PUBLIC_URL` | Adresse publique du tableau de bord (`https://monitoring.example.fr`). Recommandée : utilisée dans les commandes d'installation et pour la vérification d'origine. |
| `HLM_TRUSTED_PROXIES` | CIDR des reverse proxies autorisés à transmettre `X-Forwarded-For` / `X-Forwarded-Proto`. Vide : en-têtes ignorés. |
| `HLM_LISTEN` | Adresse d'écoute (`:8080`). |
| `HLM_DATA_DIR` | Répertoire de la base et de la clé du hub (`/data`). |

**HTTP ou HTTPS.** Le hub fonctionne directement en HTTP (`http://192.168.1.10:8080`), sans reverse proxy : interface, API et agents. Les commandes d'installation générées ajoutent alors `ALLOW_INSECURE=true` automatiquement. En HTTP, l'agent continue de vérifier la signature du hub, mais les échanges (métriques, jeton, mot de passe de connexion) circulent en clair sur le réseau : à réserver à un réseau local de confiance.

Derrière un reverse proxy HTTPS (Caddy, Traefik, Nginx), le cookie de session devient `Secure`, HSTS est activé, le lien agent ↔ hub est chiffré et l'interface peut s'installer en PWA hors ligne. Les deux accès peuvent coexister : un même hub reste joignable en HTTP sur le LAN et en HTTPS via le proxy.

## Installer l'agent

Dans l'interface : **Hôtes → Ajouter un hôte** ouvre un assistant en trois étapes (machine, installation, vérification de la connexion). La commande affichée installe l'agent comme service systemd (démarrage au boot, redémarrage automatique, mise à jour quotidienne) :

```sh
curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/install.sh \
  | sudo HUB_URL='https://monitoring.example.fr' TOKEN='…' KEY='…' sh
```

Le script est idempotent et non interactif : relancé sans `TOKEN`, il met seulement le binaire à jour. Pour un parc entier, le rôle Ansible [`deploy/ansible/roles/hlm_agent`](deploy/ansible/roles/hlm_agent) enregistre chaque machine automatiquement via l'API. Tout est détaillé dans [docs/AGENT.md](docs/AGENT.md).

## Sécurité

- **Agent ↔ hub, authentification mutuelle (modèle Beszel)** : l'agent ouvre une WebSocket vers le hub avec son jeton (stocké haché côté hub) et un nonce aléatoire ; le hub doit signer ce nonce avec sa clé ed25519, dont l'agent connaît la clé publique (`KEY`). Un faux hub ne peut donc pas recevoir les métriques. L'agent refuse `http://` sauf `ALLOW_INSECURE=true`.
- L'agent tourne sous un utilisateur dédié, sans capacités, avec un service systemd durci (`ProtectSystem=strict`, filtres d'appels système, 64 Mo max).
- SMART demande un accès root aux disques : il est confié à un petit script appartenant à root (`/usr/local/lib/hlm-agent/smart-collect.sh`), lancé toutes les heures par un timer systemd sans réseau, qui n'exécute que `smartctl`. Root n'exécute jamais le binaire de l'agent, que l'agent peut réécrire pour se mettre à jour. `SMART=false` à l'installation désactive cette partie.
- Mises à jour de l'agent : téléchargées uniquement depuis les releases GitHub du dépôt, vérifiées par SHA-256, remplacées atomiquement.
- Hub : mots de passe Argon2id, sessions aléatoires stockées hachées (cookie `HttpOnly`, `SameSite=Strict`), anti-CSRF par vérification d'origine, limitation des tentatives de connexion, CSP stricte, entrées JSON validées et bornées, modèles d'e-mail échappés, aucun secret dans les exports. Conteneur distroless non-root, système de fichiers en lecture seule.

## Développement

```sh
cd server && go run .                        # hub sur :8080 (données dans ./data)
cd web && npm install && npm run dev         # interface sur :5173, API proxifiée vers 127.0.0.1:8080 (HLM_API pour changer)
cd rust-agent && HUB_URL=http://127.0.0.1:8080 ALLOW_INSECURE=true TOKEN=… KEY=… cargo run
```

**Mode test** : `cd server && go run -tags devmode .` crée le compte `admin` / `devmode-password`, trois hôtes de démonstration alimentés par des métriques simulées et quelques sondes locales. Ce mode n'existe que dans un binaire compilé avec `-tags devmode` : l'image Docker et les releases (branche `stable`) ne le contiennent pas, aucune variable ne peut l'activer, et un binaire `devmode` refuse de démarrer s'il porte un numéro de version de release. La CI vérifie que le tag n'est jamais utilisé.

`npm run build` produit l'interface dans `server/web/dist`, embarquée dans le binaire Go. Tests : `go test ./...` (server), `cargo test` (rust-agent).

## Publication

Le workflow [`release.yml`](.github/workflows/release.yml) s'exécute **uniquement sur un push vers `stable`** : tests, puis binaires agent `x86_64` et `aarch64` (musl statique, compatibles avec toute version de Debian) et image `ghcr.io/midnights-ra1n/homelab-monitoring` multi-arch (`linux/amd64`, `linux/arm64`). Les builds ARM64 tournent nativement sur des runners Ubuntu 24.04 ARM. Chaque publication crée la release `v0.1.<n>` utilisée par la mise à jour automatique des agents.

## Feuille de route

Prévu dans les prochaines étapes (voir AGENTS.md) :

- Agent : services systemd, programmation des mises à jour et des redémarrages, Docker (conteneurs, ressources, mises à jour d'images), surveillance CVE.
- Serveur MCP activable pour interroger le monitoring depuis Claude.
- Passkeys (uniquement en HTTPS derrière un reverse proxy).
- Éditeur graphique pour le modèle d'e-mail, widgets supplémentaires pour le tableau de bord et la page de statut.
