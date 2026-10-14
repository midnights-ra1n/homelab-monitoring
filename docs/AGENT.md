# Déployer l'agent

L'agent `hlm-agent` est un binaire Rust statique (musl) pour Debian, en `x86_64` et `aarch64`. Il fonctionne sur toutes les versions de Debian, quelle que soit leur glibc. Il tourne comme service systemd sous l'utilisateur `hlm-agent`, sans privilèges, démarre au boot et se met à jour chaque jour.

| Besoin | Méthode |
|---|---|
| Une machine | *Hôtes → Ajouter un hôte* : assistant en 3 étapes, une ligne à copier |
| Plusieurs machines | *Hôtes → Déploiement en masse* : un **jeton commun**, la même ligne (ou les mêmes variables Ansible) partout |
| Un parc géré par Ansible | Le rôle `hlm_agent` : voir **[docs/ANSIBLE.md](ANSIBLE.md)** |
| Un Proxmox et ses conteneurs LXC | Assistant, type *Serveur Proxmox* : voir [Proxmox et LXC](#proxmox-et-conteneurs-lxc) |
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

## Proxmox et conteneurs LXC

Dans l'assistant, le type *Serveur Proxmox* propose **Installer aussi dans les conteneurs LXC Debian démarrés**, activé par défaut. La commande contient alors `LXC=all` et un jeton commun valable 7 jours (`LXC_TOKEN`). Le script :

1. installe l'agent sur le Proxmox lui-même ;
2. pour chaque conteneur démarré (`pct list`), vérifie qu'il s'agit d'une Debian avec systemd. Les autres conteneurs sont ignorés ;
3. copie le binaire, déjà vérifié, et les fichiers d'installation dans le conteneur avec `pct push`. **Aucun accès Internet n'est nécessaire dans les conteneurs**, seulement l'accès au hub ;
4. lance l'installation dans le conteneur, sans SMART. Chaque conteneur s'inscrit sous son nom avec le jeton commun.

Il affiche ensuite un bilan (`CT 101 (nextcloud): installed`…). Relancez la même ligne pour équiper les conteneurs créés depuis : ceux qui ont déjà l'agent ne sont pas réinscrits. Les conteneurs arrêtés et les machines virtuelles (QEMU) ne sont pas concernés ; installez l'agent dans une VM comme sur n'importe quelle machine.

Dans un conteneur non privilégié sans *nesting*, systemd ne peut pas toujours mettre en place l'isolation du service (espaces de noms). Le script le détecte et ajoute alors `/etc/systemd/system/hlm-agent.service.d/container.conf`, qui retire ces protections **dans ce conteneur uniquement**.

Désinstaller partout : `curl -fsSL …/uninstall.sh | sudo LXC=all sh` sur le Proxmox.

## Docker

Si Docker est installé au moment de l'installation de l'agent, le suivi Docker s'active tout seul. Pour le forcer : `DOCKER=true` ; pour le couper : `DOCKER=false`. Si vous installez Docker plus tard, relancez `install.sh`.

- **Toutes les minutes** : un script root (`docker-helper.sh collect`, lancé par `hlm-agent-docker.timer`, sans réseau) enregistre `docker inspect` et `docker stats`. L'agent lit ce relevé, sans jamais accéder lui-même au socket Docker, qui donne l'équivalent des droits root. Le relevé donne l'état, le healthcheck, les redémarrages, le CPU, la mémoire et le réseau de chaque conteneur.
- **Toutes les 6 heures** (et 2 minutes après le démarrage) : l'agent compare l'empreinte de chaque image locale à celle publiée sur son registre (Docker Hub, GHCR, Quay, registres auto-hébergés…). Il lit seulement l'empreinte du manifeste, sans rien télécharger et sans privilèges. Résultats possibles :
  - « Mise à jour disponible » ou « À jour » ;
  - « Image locale » pour une image construite sur la machine ;
  - « Figée » pour une image référencée par son empreinte ;
  - « Inconnu » pour un registre privé ou injoignable.
- **Mettre à jour un conteneur** depuis la page *Conteneurs* ou la fiche de l'hôte. Ce n'est possible que pour les conteneurs **Docker Compose**. Le helper root lit les labels Compose du conteneur et lance, dans son dossier, `docker compose pull <service>` puis `docker compose up -d <service>`. Les volumes sont conservés et le journal s'affiche au retour. Les conteneurs lancés avec `docker run` sont signalés, mais pas recréés : leur commande d'origine n'est pas connue. Comme pour apt, `REMOTE_UPDATES=false` retire cette possibilité.

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
| `REMOTE_UPDATES` | `true` | Autoriser les boutons *Vérifier* et *Mettre à jour* (paquets apt et conteneurs Docker) |
| `DOCKER` | `auto` | Suivi Docker : activé si `docker` est installé |
| `LXC` | — | `all` sur un Proxmox : installer aussi dans chaque conteneur LXC Debian démarré |
| `LXC_TOKEN` | `TOKEN` | Jeton commun `enr_…` utilisé par les conteneurs LXC |
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
| `/usr/local/lib/hlm-agent/apt-action.sh` | `root`, `0755` | Actions apt demandées depuis le tableau de bord (`apt-get update`, `apt-get upgrade`) |
| `/etc/systemd/system/hlm-agent-apt.{path,service}` | `root` | Lance `apt-action.sh` quand l'agent dépose une demande |
| `/var/lib/hlm-agent/apt/` | `root:hlm-agent`, `0750` | État et journal de la dernière action apt |
| `/usr/local/lib/hlm-agent/docker-helper.sh` | `root`, `0755` | Relevé Docker et mise à jour d'un conteneur Compose |
| `/etc/systemd/system/hlm-agent-docker.{service,timer}` | `root` | Relevé Docker chaque minute, **sans réseau** |
| `/etc/systemd/system/hlm-agent-docker-update.{path,service}` | `root` | Mise à jour d'un conteneur demandée depuis le tableau de bord |
| `/var/lib/hlm-agent/docker/` | `root:hlm-agent`, `0750` | Relevé Docker et journal de la dernière mise à jour |

Root n'exécute jamais le binaire de l'agent : l'agent peut le réécrire pour se mettre à jour, ce qui ouvrirait une élévation de privilèges.

### Mises à jour système depuis le tableau de bord

L'agent n'a pas le droit d'installer de paquets. Les boutons *Vérifier* et *Mettre à jour* passent par un petit helper root :

1. l'agent écrit `refresh` ou `upgrade` dans `/var/lib/hlm-agent/state/apt-request` ;
2. l'unité `hlm-agent-apt.path` lance `apt-action.sh` en root ;
3. le script n'accepte que ces deux mots et exécute `apt-get update`, plus `apt-get upgrade` pour `upgrade` (configuration locale conservée, aucun paquet supprimé, pas de redémarrage) ;
4. l'agent lit le résultat dans `/var/lib/hlm-agent/apt/`, le renvoie au hub avec la fin du journal apt, puis relance l'analyse des paquets.

Un agent compromis peut donc au pire lancer une mise à jour depuis les dépôts configurés, jamais une commande arbitraire. Pour retirer cette possibilité : `REMOTE_UPDATES=false` à l'installation, ou `hlm_remote_updates: false` avec Ansible.

### Mémoire

L'agent lui-même occupe quelques Mo. L'unité autorise 256 Mo (`MemoryMax`), car l'analyse des mises à jour lance `apt-get`, qui charge tout le cache des paquets. Avec `OOMPolicy=continue`, si `apt-get` dépassait cette limite, seul `apt-get` serait arrêté et l'agent continuerait de tourner. Les unités installées avant la v0.1.3 limitaient le service à 64 Mo : relancez `install.sh` pour les mettre à jour. En attendant, un agent v0.1.3 détecte cette limite trop basse et saute l'analyse au lieu de redémarrer en boucle.

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
| `updates check skipped: service memory limit 64 MiB is too low` | Unité systemd d'avant la v0.1.3 | Relancez `install.sh` (sans `TOKEN`) |
| `Failed with result 'oom-kill'` en boucle (v0.1.2) | Même cause, ancien agent | Relancez `install.sh` |

Un jeton de machine ne vaut que pour une machine. Si deux machines l'utilisent, elles se déconnectent mutuellement. Pour plusieurs machines, utilisez le jeton commun.
