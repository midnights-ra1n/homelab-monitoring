# Déployer l'agent

L'agent `hlm-agent` est un binaire Rust statique (musl) pour Debian, en `x86_64` et `aarch64`. Il fonctionne sur toutes les versions de Debian, quelle que soit leur glibc. Il tourne comme service systemd sous l'utilisateur `hlm-agent`, sans privilèges, démarre au boot et se met à jour chaque jour.

| Besoin | Méthode |
|---|---|
| Une machine | *Hôtes → Ajouter un hôte* : assistant en 3 étapes, une ligne à copier |
| Plusieurs machines | *Hôtes → Déploiement en masse* : un **jeton commun**, la même ligne (ou les mêmes variables Ansible) partout |
| Un parc géré par Ansible | Le rôle `hlm_agent` : voir **[docs/ANSIBLE.md](ANSIBLE.md)** |
| Retirer l'agent | Une ligne : [Désinstaller](#désinstaller) |

## Ajouter une machine

*Hôtes → Ajouter un hôte* :

1. **Machine** : nom, type (machine virtuelle, Proxmox, serveur physique, poste client), SMART et mise à jour automatique.
2. **Installation** : l'**adresse du hub** (modifiable, et mémorisée pour les prochains hôtes), puis la commande à copier, ou les variables Ansible, ou l'installation manuelle.
3. **Connexion** : l'assistant attend la première connexion de l'agent et affiche les premières mesures.

```sh
curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/install.sh \
  | sudo HUB_URL='https://monitoring.example.fr' TOKEN='…' KEY='…' sh
```

L'adresse du hub utilisée dans les commandes est, par ordre de priorité :
1. celle saisie dans l'assistant ;
2. sinon `HLM_PUBLIC_URL` du conteneur ;
3. sinon l'adresse avec laquelle vous avez ouvert le tableau de bord.

## Plusieurs machines : le jeton commun

*Hôtes → Déploiement en masse* crée un jeton commun (`enr_…`), valable 24 heures, 7 jours, 30 jours ou sans limite.

- **La même commande et la même clé** sur toutes les machines.
- À sa première connexion, chaque agent s'inscrit sous **son nom de machine** (`pve-01`, `nas`…). En cas de doublon, un suffixe est ajouté (`pve-01-2`).
- L'agent reçoit alors son **propre jeton**, enregistré dans `/var/lib/hlm-agent/state/token`, et n'utilise plus le jeton commun.
- Le jeton commun ne permet donc que d'inscrire de nouvelles machines, jamais d'usurper une machine existante. Une fois le déploiement fini, vous pouvez le révoquer.
- Si vous supprimez un hôte inscrit de cette façon alors que son agent tourne encore, l'agent se réinscrit tant que le jeton commun est valide. Désinstallez d'abord l'agent.

## Options de install.sh

`install.sh` est idempotent et non interactif. Relancé sans `TOKEN`, il met seulement à jour le binaire et les unités, sans toucher à la configuration.

| Variable | Défaut | Rôle |
|---|---|---|
| `HUB_URL` | — | Adresse du hub (`https://…`, ou `http://…` avec `ALLOW_INSECURE=true`) |
| `TOKEN` | — | Jeton de la machine ou jeton commun `enr_…` |
| `KEY` | — | Clé publique du hub |
| `ALLOW_INSECURE` | `false` | Accepter un hub en HTTP (liaison non chiffrée) |
| `AUTO_UPDATE` | `true` | Mise à jour quotidienne depuis les releases GitHub |
| `SMART` | `true` | Installer smartmontools et la collecte SMART horaire |
| `VERSION` | dernière | Installer une release précise (`v0.1.4`) |
| `REPO` | `midnights-ra1n/homelab-monitoring` | Dépôt hébergeant les releases (fork) |

## Désinstaller

```sh
curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/uninstall.sh | sudo sh
```

Cela retire les services, le timer SMART, le binaire, la configuration, l'état et l'utilisateur `hlm-agent` ; smartmontools reste installé. Supprimez ensuite l'hôte dans le tableau de bord (la commande est rappelée dans la fenêtre de suppression). Avec Ansible : `hlm_agent_state: absent` ([docs/ANSIBLE.md](ANSIBLE.md#6-désinstaller)).

## Ce qui est installé

| Chemin | Propriétaire | Rôle |
|---|---|---|
| `/opt/hlm-agent/hlm-agent` | `hlm-agent`, `0755` | Binaire (modifiable par l'agent pour sa mise à jour) |
| `/etc/hlm-agent/agent.env` | `root:hlm-agent`, `0640` | Configuration |
| `/var/lib/hlm-agent/state/token` | `hlm-agent`, `0600` | Jeton personnel d'une machine inscrite avec un jeton commun |
| `/etc/systemd/system/hlm-agent.service` | `root` | Service durci : `ProtectSystem=strict`, aucune capacité, filtres d'appels système, 64 Mo de mémoire au maximum |
| `/usr/local/lib/hlm-agent/smart-collect.sh` | `root`, `0755` | Collecte SMART (lance seulement `smartctl`) |
| `/etc/systemd/system/hlm-agent-smart.{service,timer}` | `root` | Collecte SMART horaire, en root, **sans réseau** |
| `/var/lib/hlm-agent/smart/` | `root:hlm-agent`, `0750` | Résultats SMART lus par l'agent |

Root n'exécute jamais le binaire de l'agent : l'agent peut le réécrire pour se mettre à jour, ce qui ouvrirait une élévation de privilèges.

## Vérifier et dépanner

```sh
systemctl status hlm-agent
journalctl -u hlm-agent -n 50
/opt/hlm-agent/hlm-agent --version
```

| Message dans le journal | Cause | Solution |
|---|---|---|
| `hub rejected TOKEN (401)` | Jeton erroné, révoqué, expiré, ou régénéré | Réinstallez avec un jeton valide |
| `personal token rejected, falling back to TOKEN` | Hôte supprimé ou jeton régénéré dans le tableau de bord | Normal : l'agent se réinscrit avec le jeton commun |
| `hub signature invalid: KEY does not match this hub` | `KEY` ne correspond pas à ce hub (autre instance, ou volume `/data` recréé) | Reprenez la clé affichée par le hub |
| `HUB_URL uses plain http` | Hub en HTTP sans `ALLOW_INSECURE=true` | Ajoutez-le, ou passez le hub en HTTPS |
| `connection timed out` | Hub injoignable depuis la machine | Pare-feu, DNS, adresse du hub, port publié du conteneur |

Un jeton de machine ne vaut que pour une machine. Si deux machines l'utilisent, elles se déconnectent mutuellement. Pour plusieurs machines, utilisez le jeton commun.
