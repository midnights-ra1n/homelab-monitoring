# API Homelab Monitoring — v1

API REST intégrée au hub, pour exposer les données de supervision à un autre outil (par exemple un tableau de bord de gestion du homelab). Elle est servie par le même conteneur, sur le même port, sous le préfixe `/api/v1`.

- **Désactivée par défaut.** Activez-la dans *Réglages → API*. Tant qu'elle est désactivée, toutes les routes répondent `404`.
- **Authentification par jeton uniquement.** Le cookie de session du tableau de bord n'est jamais accepté sur `/api/v1`.
- **Lecture seule**, à l'exception de la mise en maintenance (scope `maintenance:write`).
- Réponses en JSON UTF-8, horodatages en **secondes Unix** (sauf mention contraire).

## Sommaire

1. [Jetons](#jetons)
2. [Authentification](#authentification)
3. [Scopes](#scopes)
4. [Erreurs et limites](#erreurs-et-limites)
5. [Appels depuis un navigateur (CORS)](#appels-depuis-un-navigateur-cors)
6. [Valeurs d'état](#valeurs-détat)
7. [Routes](#routes)
8. [Exemples d'intégration](#exemples-dintégration)
9. [Sécurité](#sécurité)
10. [Versionnement](#versionnement)

## Jetons

Dans *Réglages → API → Créer un jeton* :

| Champ | Description |
|---|---|
| Nom | Libellé libre (ex. `homelab-management`). Un jeton par application : chacun se révoque indépendamment. |
| Expiration | 30 jours, 90 jours, 1 an, une date précise (au plus 5 ans), ou jamais. Un jeton expiré est refusé avec `401`. |
| Scopes | Les droits du jeton, voir ci-dessous. Au moins un. |

Le jeton (`hlm_` suivi de 43 caractères base64url) n'est **affiché qu'une seule fois**. Le hub n'en conserve que l'empreinte SHA-256 ; seul le préfixe (`hlm_AbC123…`) reste visible dans la liste. La liste indique aussi la dernière utilisation (précision d'une minute). La révocation est immédiate.

## Authentification

Chaque requête porte l'en-tête :

```http
Authorization: Bearer hlm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```sh
curl -H "Authorization: Bearer $HLM_TOKEN" https://monitoring.example.fr/api/v1/status
```

En HTTP (sans reverse proxy HTTPS), le jeton circule en clair : réservez cet usage à un réseau local de confiance.

## Scopes

| Scope | Routes |
|---|---|
| `status:read` | `GET /api/v1/status` |
| `hosts:read` | `GET /api/v1/hosts`, `GET /api/v1/hosts/{id}` |
| `hosts:write` | `POST /api/v1/hosts` (enregistrement d'un hôte, utilisé par le rôle Ansible) |
| `metrics:read` | `GET /api/v1/hosts/{id}/metrics` |
| `monitors:read` | `GET /api/v1/monitors`, `GET /api/v1/monitors/{id}`, `GET /api/v1/monitors/{id}/results` |
| `updates:read` | `GET /api/v1/updates` |
| `smart:read` | `GET /api/v1/disks` |
| `reports:read` | `GET /api/v1/reports/monthly` |
| `maintenance:write` | `PUT /api/v1/hosts/{id}/maintenance`, `PUT /api/v1/monitors/{id}/maintenance` |

Donnez à chaque jeton le minimum nécessaire. Un tableau de bord qui n'affiche que l'état global n'a besoin que de `status:read`.

## Erreurs et limites

Les erreurs ont toujours la forme :

```json
{ "error": "Ce jeton n'a pas le scope monitors:read" }
```

| Code | Signification |
|---|---|
| `200` | Succès |
| `204` | Succès sans contenu (pré-vol CORS) |
| `400` | Paramètre ou corps invalide (le message énonce la règle attendue) |
| `401` | Jeton absent, invalide, révoqué ou expiré |
| `403` | Jeton valide sans le scope requis |
| `404` | Ressource inconnue, ou API désactivée |
| `429` | Trop de requêtes. Respectez l'en-tête `Retry-After` (secondes) |
| `500` | Erreur interne (détail dans les journaux du hub) |

- **600 requêtes par minute et par jeton.**
- Les jetons invalides sont aussi limités par adresse IP (protection contre la recherche de jetons).
- Les corps JSON sont limités à 4 Mo ; les champs inconnus sont refusés.
- Les réponses ne sont pas mises en cache (`Cache-Control: no-store`).

Interroger `/status` toutes les 15 à 60 secondes suffit : les agents remontent leurs mesures toutes les 30 secondes par défaut et les sondes ont leur propre intervalle.

## Appels depuis un navigateur (CORS)

Par défaut, aucune origine tierce n'est autorisée : l'API est faite pour être appelée **côté serveur**, où le jeton reste secret. Si votre outil appelle l'API directement depuis le navigateur, ajoutez son origine dans *Réglages → API → Origines autorisées* (ex. `https://gestion.example.fr`, plusieurs séparées par des virgules). Le hub renvoie alors `Access-Control-Allow-Origin` pour cette origine, et répond aux pré-vols `OPTIONS` avec les en-têtes `Authorization` et `Content-Type`, et les méthodes `GET`, `POST` et `PUT`.

Le jeton est alors lisible par quiconque ouvre l'outil : donnez-lui uniquement des scopes de lecture.

## Valeurs d'état

Utilisées par les hôtes, les sondes et l'état global (de la meilleure à la pire) :

| Valeur | Libellé |
|---|---|
| `operational` | Opérationnel |
| `maintenance` | Maintenance |
| `degraded` | Performances dégradées (réponse lente, disque ou mémoire ≥ 95 %) |
| `minor_outage` | Panne partielle (service joignable mais réponse incorrecte) |
| `major_outage` | Panne majeure (injoignable, agent silencieux, certificat expiré) |
| `unknown` | Pas encore vérifié |

L'état global est le pire état parmi les hôtes et les sondes actives.

## Routes

### `GET /api/v1/status`

Scope `status:read`. Résumé de l'infrastructure.

```json
{
  "status": "degraded",
  "hosts": { "total": 5, "by_status": { "operational": 4, "major_outage": 1 } },
  "monitors": { "total": 12, "by_status": { "operational": 11, "degraded": 1 } },
  "time": 1792046280
}
```

### `GET /api/v1/hosts`

Scope `hosts:read`. Liste des hôtes équipés de l'agent, triée par nom. Ajoutez `?packages=1` pour inclure la liste des paquets en attente (sinon seuls les compteurs sont renvoyés).

```json
[
  {
    "id": 1,
    "name": "pve-01",
    "status": "operational",
    "last_seen": 1792046270,
    "maintenance": false,
    "public": false,
    "connected": true,
    "info": {
      "hostname": "pve-01", "os": "Debian GNU/Linux 13 (trixie)", "kernel": "6.12.0", "arch": "x86_64",
      "cpu_model": "AMD Ryzen 7 5700G", "cpu_cores": 16, "mem_total": 68719476736,
      "agent_version": "v0.1.42", "boot_time": 1791700000
    },
    "latest": {
      "cpu": 12.5, "mem_used": 21474836480, "mem_total": 68719476736, "swap_used": 0, "swap_total": 8589934592,
      "disk_used": 400000000000, "disk_total": 1000000000000, "net_rx": 125000.5, "net_tx": 40000.2,
      "load1": 0.84, "temp": 48.0,
      "disks": [{ "mount": "/", "fs": "ext4", "used": 400000000000, "total": 1000000000000 }],
      "temps": [{ "label": "k10temp Tctl", "c": 48.0 }],
      "ifaces": [{ "name": "enp5s0", "rx": 125000.5, "tx": 40000.2 }]
    },
    "updates": {
      "manager": "apt", "reboot_required": false, "lists_updated_at": 1792030000,
      "checked_at": 1792040000, "pending": 4, "security": 2
    },
    "created_at": 1791000000
  }
]
```

| Champ | Unité / remarque |
|---|---|
| `latest.cpu` | % d'utilisation, tous cœurs |
| `latest.mem_*`, `swap_*`, `disk_*`, `disks[].used/total` | octets |
| `latest.net_rx`, `net_tx`, `ifaces[].rx/tx` | octets par seconde (le total exclut les interfaces virtuelles) |
| `latest.temp` | °C, capteur le plus chaud, `null` si aucun capteur |
| `last_seen` | dernière mesure reçue ; `0` si l'agent ne s'est jamais connecté |
| `connected` | l'agent a une connexion ouverte en ce moment |
| `updates` | `null` tant que l'agent n'a rien remonté (ou système sans apt) |

### `POST /api/v1/hosts`

Scope `hosts:write`. Enregistre un hôte et renvoie les identifiants de son agent. C'est la route utilisée par le rôle Ansible pour un déploiement sans intervention ([docs/AGENT.md](AGENT.md)).

```http
POST /api/v1/hosts
Content-Type: application/json

{ "name": "pve-02", "rotate_if_exists": false }
```

`201 Created` :

```json
{
  "id": 7,
  "name": "pve-02",
  "created": true,
  "install": {
    "hub_url": "https://monitoring.example.fr",
    "key": "MCowBQYDK2VwAyEAexampleexampleexampleexa=",
    "token": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd",
    "command": "curl -fsSL … | sudo HUB_URL='…' TOKEN='…' KEY='…' sh"
  }
}
```

- `409` si un hôte porte déjà ce nom.
- Avec `"rotate_if_exists": true`, l'hôte existant reçoit un nouveau jeton (`200`, `"created": false`) : l'ancien agent est déconnecté et l'historique est conservé.
- Le jeton d'agent n'est renvoyé qu'ici ; conservez-le comme un secret.
- `hub_url` est construit à partir de `HLM_PUBLIC_URL` si elle est définie, sinon de l'adresse utilisée pour l'appel.

### `GET /api/v1/hosts/{id}`

Scope `hosts:read`. Un hôte, au même format, avec `updates.packages` :

```json
"packages": [
  { "name": "libssl3", "current": "3.0.11-1~deb12u1", "candidate": "3.0.11-1~deb12u2", "security": true }
]
```

`404` si l'hôte n'existe pas.

### `GET /api/v1/hosts/{id}/metrics?range=24h`

Scope `metrics:read`. Historique moyenné en environ 300 points. `range` : `1h`, `6h`, `24h` (défaut), `7d`, `30d`, `90d` (limité par la rétention configurée). Format en colonnes, chaque tableau aligné sur `t` :

```json
{
  "t":      [1791960000, 1791960300],
  "cpu":    [12.1, 14.8],
  "mem":    [31.2, 31.4],
  "swap":   [0, 0],
  "disk":   [40.0, 40.0],
  "net_rx": [120000.0, 98000.5],
  "net_tx": [40000.0, 35000.1],
  "load1":  [0.8, 1.1],
  "temp":   [47.5, null]
}
```

`cpu`, `mem`, `swap`, `disk` en %, `net_*` en octets/s, `temp` en °C (maximum de la tranche). `null` = pas de donnée.

### `PUT /api/v1/hosts/{id}/maintenance`

Scope `maintenance:write`. Active ou désactive la maintenance (l'hôte passe en `maintenance` et ne déclenche plus d'alerte). Pratique autour d'une mise à jour lancée par votre outil.

```http
PUT /api/v1/hosts/1/maintenance
Content-Type: application/json

{ "maintenance": true }
```

```json
{ "id": 1, "maintenance": true }
```

### `GET /api/v1/monitors`

Scope `monitors:read`. Toutes les sondes, avec la disponibilité des 90 derniers jours.

```json
[
  {
    "id": 3,
    "name": "Nextcloud",
    "type": "http",
    "target": "https://cloud.example.fr/status.php",
    "interval_s": 60,
    "timeout_s": 10,
    "config": { "method": "GET", "expected_status": "200-399", "check_ssl": true, "warn_days": 3 },
    "enabled": true,
    "maintenance": false,
    "public": false,
    "status": "operational",
    "message": "HTTP 200 · certificat valide 58 jours",
    "latency_ms": 142.3,
    "last_check": 1792046250123,
    "cert_expires_at": 1797019346,
    "days": [
      { "day": 1784246400, "uptime": 1, "worst": "operational" },
      { "day": 1784332800, "uptime": 0.9861, "worst": "major_outage" },
      { "day": 1784419200, "uptime": null, "worst": "unknown" }
    ]
  }
]
```

| Champ | Remarque |
|---|---|
| `type` | `http`, `tcp`, `dns` ou `ssl` |
| `config` | dépend du type : `method`, `expected_status`, `keyword`, `ignore_tls`, `check_ssl`, `degraded_ms`, `dns_server`, `record_type`, `expected`, `warn_days`, `failure_threshold` |
| `last_check` | **millisecondes** Unix |
| `latency_ms` | dernière latence, `null` en cas d'échec |
| `cert_expires_at` | expiration du certificat suivi (sondes `ssl` ou `http` avec `check_ssl`), sinon `null` |
| `days[]` | un élément par jour (minuit UTC), du plus ancien au plus récent ; `uptime` entre 0 et 1, `null` sans mesure ; `worst` = pire état du jour |

### `GET /api/v1/monitors/{id}`

Scope `monitors:read`. Une sonde, même format. `404` si inconnue.

### `GET /api/v1/monitors/{id}/results?range=24h`

Scope `monitors:read`. Latence moyenne par tranche (environ 300 points) et les 50 dernières vérifications. `range` : `1h`, `6h`, `24h`, `7d`, `30d`, `90d`.

```json
{
  "t":       [1791960000, 1791960288],
  "latency": [140.2, null],
  "worst":   ["operational", "major_outage"],
  "recent":  [
    { "ts": 1792046250123, "status": "operational", "latency_ms": 142.3, "message": "HTTP 200" }
  ]
}
```

`t` en secondes, `recent[].ts` en millisecondes.

### `PUT /api/v1/monitors/{id}/maintenance`

Scope `maintenance:write`. Même corps et même réponse que pour les hôtes.

### `GET /api/v1/updates`

Scope `updates:read`. Mises à jour en attente sur chaque hôte, avec la liste des paquets.

```json
[
  {
    "host_id": 1,
    "host": "pve-01",
    "updates": {
      "manager": "apt",
      "packages": [{ "name": "openssh-server", "current": "1:9.2p1-2+deb12u2", "candidate": "1:9.2p1-2+deb12u3", "security": true }],
      "reboot_required": false,
      "lists_updated_at": 1792030000,
      "checked_at": 1792040000,
      "pending": 1,
      "security": 1
    }
  }
]
```

L'agent analyse les mises à jour au démarrage puis toutes les 6 heures, à partir des listes apt actualisées par `apt-daily.timer`. `lists_updated_at` indique leur fraîcheur.

### `GET /api/v1/disks`

Scope `smart:read`. Santé SMART des disques, par hôte. Les hôtes sans collecte SMART n'apparaissent pas.

```json
[
  {
    "host_id": 2,
    "host": "nas",
    "collected_at": 1792044000,
    "disks": [
      {
        "name": "/dev/sda", "model": "WDC WD40EFRX-68N32N0", "serial": "WD-WX12", "kind": "hdd",
        "capacity_bytes": 4000787030016, "smart_passed": true, "temperature_c": 36, "power_on_hours": 27000,
        "reallocated": 8, "pending": 0, "offline_uncorrectable": 0, "reported_uncorrect": 0, "crc_errors": 0,
        "wear_used_pct": null, "data_written_bytes": null,
        "health": "watch",
        "score": 70,
        "usable": true,
        "summary": "Utilisable, à surveiller.",
        "reasons": ["8 secteur(s) remplacé(s) : à surveiller"],
        "life_left_days": 700,
        "life_basis": "Durée de vie habituelle d'un disque dur : 5 ans en fonctionnement continu"
      }
    ]
  }
]
```

| Champ | Remarque |
|---|---|
| `kind` | `hdd`, `ssd` (SATA) ou `nvme` |
| `health` | `good` (bon état), `watch` (à surveiller), `replace` (à remplacer), `failing` (défaillant) |
| `score` | 0 à 100 : usure (SSD) ou âge (HDD), moins une pénalité selon `health` |
| `usable` | `true` pour `good` et `watch` |
| `reasons` | explications en français, vides si tout va bien |
| `life_left_days` | **estimation** : extrapolation de l'usure (SSD) ou durée de vie habituelle de 5 ans (HDD) ; `0` si remplacement conseillé ; `null` si non estimable |
| `error` | présent si `smartctl` est absent de l'hôte |

Les champs SMART bruts valent `null` quand le disque ne les expose pas (les machines virtuelles n'en exposent généralement aucun).

### `GET /api/v1/reports/monthly?month=2026-09`

Scope `reports:read`. Rapport d'un mois (`AAAA-MM`, mois précédent par défaut). Le mois en cours est calculé jusqu'à maintenant.

```json
{
  "month": "2026-09",
  "from": 1788220800,
  "to": 1790812800,
  "uptime": 0.9987,
  "host_availability": 0.9991,
  "incident_days": 2,
  "monitors": [
    { "id": 3, "name": "Nextcloud", "type": "http", "uptime": 0.9952, "avg_latency_ms": 151.2, "incident_days": 1, "worst": "major_outage" }
  ],
  "hosts": [
    { "id": 1, "name": "pve-01", "availability": 0.9995, "cpu_avg": 14.2, "mem_avg": 33.1 }
  ],
  "certificates_expiring": [],
  "pending_updates": 6,
  "security_updates": 4,
  "disks_attention": [],
  "generated_at": 1792046280
}
```

- `uptime` est la moyenne des disponibilités des sondes ayant des mesures sur le mois.
- `incident_days` compte les jours où une sonde a connu une panne partielle ou majeure.
- `host_availability` est la part des relevés d'agent reçus par rapport à ceux attendus (avec l'intervalle d'agent actuel).
- `certificates_expiring`, `pending_updates`, `security_updates` et `disks_attention` décrivent la situation **au moment de la génération**, pas l'historique. `certificates_expiring` contient des sondes au format de `/monitors`, et `disks_attention` des disques au format de `/disks`, avec l'hôte dans `name`.
- Les données s'appuient sur les relevés journaliers, conservés 365 jours par défaut (*Réglages → Collecte et rétention*).

## Exemples d'intégration

### Shell

```sh
export HLM_URL=https://monitoring.example.fr HLM_TOKEN=hlm_xxx

# État global
curl -fsS -H "Authorization: Bearer $HLM_TOKEN" "$HLM_URL/api/v1/status" | jq -r .status

# Hôtes en panne
curl -fsS -H "Authorization: Bearer $HLM_TOKEN" "$HLM_URL/api/v1/hosts" \
  | jq -r '.[] | select(.status == "major_outage") | .name'

# Mettre un hôte en maintenance pendant une mise à jour
curl -fsS -X PUT -H "Authorization: Bearer $HLM_TOKEN" -H "Content-Type: application/json" \
  -d '{"maintenance":true}' "$HLM_URL/api/v1/hosts/1/maintenance"
```

### TypeScript (côté serveur)

```ts
const HLM_URL = process.env.HLM_URL!;
const HLM_TOKEN = process.env.HLM_TOKEN!;

type Status = "operational" | "degraded" | "maintenance" | "minor_outage" | "major_outage" | "unknown";

async function hlm<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${HLM_URL}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${HLM_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 429) throw new Error(`Rate limited, retry in ${res.headers.get("Retry-After")} s`);
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${body.error}`);
  return body as T;
}

const summary = await hlm<{ status: Status; hosts: { total: number }; monitors: { total: number } }>("/status");
const hosts = await hlm<{ id: number; name: string; status: Status; latest: { cpu?: number } }[]>("/hosts");
await hlm(`/hosts/${hosts[0].id}/maintenance`, { method: "PUT", body: JSON.stringify({ maintenance: true }) });
```

### Python

```python
import os, requests

s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['HLM_TOKEN']}"
base = os.environ["HLM_URL"] + "/api/v1"

r = s.get(f"{base}/disks", timeout=10)
r.raise_for_status()
for host in r.json():
    for d in host["disks"]:
        if not d["usable"]:
            print(f"{host['host']} {d['name']} {d['model']}: {d['summary']}")
```

## Sécurité

- Le hub ne stocke que l'empreinte SHA-256 des jetons ; une fuite de la base ne révèle aucun jeton utilisable.
- `/api/v1` n'accepte que les jetons : pas de cookie, donc pas de risque de CSRF depuis un site tiers.
- Les champs `target` des sondes (adresses internes) sont exposés par `monitors:read` : ne donnez ce scope qu'à des outils de confiance.
- Préférez des jetons à durée limitée, et révoquez immédiatement un jeton qui aurait fuité.
- Désactiver l'API dans les réglages coupe instantanément tous les jetons, sans les supprimer.

## Versionnement

Le préfixe `/api/v1` est stable. Des champs peuvent être **ajoutés** aux réponses sans changer de version : ignorez les champs inconnus. Toute suppression ou modification incompatible fera l'objet d'un préfixe `/api/v2`, avec `v1` maintenu en parallèle.
