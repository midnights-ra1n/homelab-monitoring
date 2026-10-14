# Déployer l'agent

L'agent `hlm-agent` est un binaire Rust statique (musl) pour Debian, en `x86_64` et `aarch64`. Il fonctionne sur toutes les versions de Debian, quelle que soit leur glibc. Il tourne comme service systemd sous l'utilisateur dédié `hlm-agent`, sans privilèges, démarre au boot et se met à jour chaque jour.

Trois façons de l'installer :

| Méthode | Pour | Jeton |
|---|---|---|
| [Assistant + commande](#1-assistant-et-commande-curl) | une machine à la fois | créé par l'assistant |
| [Rôle Ansible + jeton API](#2-ansible--déploiement-de-masse-recommandé) | tout un parc, sans interface | chaque hôte s'enregistre seul |
| [Rôle Ansible + jetons par hôte](#option-b--jetons-créés-dans-linterface) | parc existant, jetons déjà créés | un par hôte, dans `host_vars` |

## 1. Assistant et commande curl

*Hôtes → Ajouter un hôte* ouvre un assistant en trois étapes :

1. **Machine** : nom, type (machine virtuelle, Proxmox, serveur physique, poste client), surveillance SMART et mise à jour automatique. Le type règle seulement la valeur par défaut de SMART, que les machines virtuelles n'exposent pas.
2. **Installation** : la commande à coller sur la machine, ou les variables Ansible, ou le contenu du fichier de configuration pour une installation manuelle.
3. **Connexion** : l'assistant attend la première connexion de l'agent, puis affiche le système détecté et les premières mesures. En cas d'échec, il rappelle les messages d'erreur fréquents.

La commande ressemble à :

```sh
curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/install.sh \
  | sudo HUB_URL='https://monitoring.example.fr' TOKEN='…' KEY='…' sh
```

`install.sh` est idempotent et non interactif :

- il télécharge le binaire de la dernière release et vérifie son empreinte SHA-256 ;
- il crée l'utilisateur `hlm-agent` et écrit `/etc/hlm-agent/agent.env` (`root:hlm-agent`, `0640`) ;
- il installe les unités systemd, et smartmontools avec le timer SMART ;
- il démarre le service.

Relancé sans `TOKEN`, il met seulement à jour le binaire et les unités, en gardant la configuration.

| Variable | Défaut | Rôle |
|---|---|---|
| `HUB_URL` | — | Adresse du hub (`https://…`, ou `http://…` avec `ALLOW_INSECURE=true`) |
| `TOKEN` | — | Jeton de l'agent (obligatoire à la première installation) |
| `KEY` | — | Clé publique du hub (ed25519, base64) |
| `ALLOW_INSECURE` | `false` | Accepter un hub en HTTP (liaison non chiffrée) |
| `AUTO_UPDATE` | `true` | Mise à jour quotidienne depuis les releases GitHub |
| `SMART` | `true` | Installer smartmontools et la collecte SMART horaire |
| `VERSION` | dernière | Installer une release précise (`v0.1.42`) |
| `REPO` | `midnights-ra1n/homelab-monitoring` | Dépôt hébergeant les releases (fork) |

Désinstallation : `curl -fsSL …/install.sh | sudo sh -s -- --uninstall`.

## 2. Ansible : déploiement de masse (recommandé)

Le rôle [`deploy/ansible/roles/hlm_agent`](../deploy/ansible/roles/hlm_agent) installe l'agent avec les modules natifs d'Ansible, sans exécuter `install.sh`.

- **Idempotent** : un second passage ne change rien. Le service ne redémarre que si le binaire, la configuration ou l'unité a changé.
- **Vérifié** : `get_url` contrôle l'empreinte SHA-256 publiée dans la release. Les métadonnées de la release sont lues une seule fois par exécution, depuis le contrôleur.
- **Sans jeton par hôte** (option A) : au premier passage, chaque machine s'enregistre via l'API du hub et reçoit son propre jeton d'agent. Les passages suivants réutilisent le jeton déjà installé.
- **Secrets protégés** : les tâches qui manipulent des jetons ont `no_log` et n'affichent pas de diff.
- **`--check` / `--diff`** pris en charge : en mode vérification, aucun hôte n'est enregistré.
- **SMART** désactivé automatiquement sur les machines virtuelles et les conteneurs (fait `virtualization_role`).

### Option A : un jeton API pour tout le parc

1. Dans le hub, *Réglages → API* : activez l'API, puis créez un jeton avec le **seul** scope `hosts:write` (par exemple 30 jours d'expiration, le temps du déploiement).
2. Préparez le dossier Ansible (le dépôt fournit des exemples) :

```text
deploy/ansible/
├── ansible.cfg
├── inventory.ini                    # depuis inventory.example.ini
├── site.yml
├── group_vars/monitored/
│   ├── main.yml                     # depuis main.example.yml
│   └── vault.yml                    # ansible-vault create …
└── roles/hlm_agent/
```

```ini
# inventory.ini
[monitored]
pve-01.lan
nas.lan
vm-docker.lan
```

```yaml
# group_vars/monitored/main.yml
hlm_hub_url: https://monitoring.example.fr
hlm_api_token: "{{ vault_hlm_api_token }}"
```

```sh
ansible-vault create group_vars/monitored/vault.yml
# vault_hlm_api_token: hlm_xxxxxxxxxxxxxxxx
```

3. Lancez :

```sh
cd deploy/ansible
ansible-playbook site.yml --ask-vault-pass --check --diff   # aperçu, rien n'est modifié
ansible-playbook site.yml --ask-vault-pass
```

Chaque hôte apparaît dans le tableau de bord sous son `inventory_hostname` (modifiable avec `hlm_host_name`). Une fois le parc déployé, vous pouvez révoquer le jeton API : les agents utilisent chacun leur propre jeton.

**Réinstaller une machine** dont `/etc/hlm-agent/agent.env` a disparu : un hôte de ce nom existe déjà, donc l'enregistrement échoue (`409`). Passez `-e hlm_rotate_if_exists=true` : l'hôte existant reçoit un nouveau jeton et garde son historique.

### Option B : jetons créés dans l'interface

Créez chaque hôte avec l'assistant (étape 2, onglet *Ansible*), qui fournit les variables à placer dans `host_vars/<hôte>.yml`, à chiffrer avec `ansible-vault encrypt` :

```yaml
hlm_hub_url: https://monitoring.example.fr
hlm_agent_token: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd
hlm_key: "MCowBQYDK2VwAyEAexampleexampleexampleexa="
```

### Variables du rôle

| Variable | Défaut | Description |
|---|---|---|
| `hlm_hub_url` | — | Adresse du hub, telle que joignable depuis les hôtes **et** depuis le contrôleur (option A) |
| `hlm_api_token` | `""` | Option A : jeton API `hosts:write` |
| `hlm_agent_token` | `""` | Option B : jeton d'agent de l'hôte |
| `hlm_key` | `""` | Clé publique du hub ; fournie par l'API en option A, obligatoire en option B |
| `hlm_host_name` | `inventory_hostname` | Nom affiché dans le tableau de bord |
| `hlm_rotate_if_exists` | `false` | Réutiliser un hôte existant du même nom avec un nouveau jeton |
| `hlm_version` | `latest` | `latest` ou une release précise (`v0.1.42`) |
| `hlm_auto_update` | `true` si `latest` | Mise à jour quotidienne par l'agent |
| `hlm_smart` | `false` sur VM et conteneur | Collecte SMART |
| `hlm_allow_insecure` | `true` si `http://` | Accepter un hub en HTTP |
| `hlm_validate_certs` | `true` | Vérifier le certificat du hub lors de l'appel API depuis le contrôleur |
| `hlm_repo` | `midnights-ra1n/homelab-monitoring` | Dépôt des releases |

**Versions figées** : avec `hlm_version: v0.1.42`, la mise à jour automatique est désactivée par défaut. Sinon, l'agent passerait à la dernière version et Ansible le ramènerait à la version figée à chaque passage. Pour monter de version, changez `hlm_version` et relancez le playbook.

**Mises à jour avec `latest`** : l'agent se met à jour seul chaque jour. Relancer le playbook n'a aucun effet s'il tourne déjà la dernière release.

### Exemples utiles

```sh
# Un seul hôte
ansible-playbook site.yml --ask-vault-pass --limit nas.lan

# Ajouter des machines : les ajouter à inventory.ini puis relancer, les autres ne bougent pas
ansible-playbook site.yml --ask-vault-pass

# Couper la mise à jour automatique sur un groupe sensible
ansible-playbook site.yml --ask-vault-pass --limit production -e hlm_auto_update=false
```

## Ce qui est installé

| Chemin | Propriétaire | Rôle |
|---|---|---|
| `/opt/hlm-agent/hlm-agent` | `hlm-agent`, `0755` | Binaire (modifiable par l'agent pour sa mise à jour) |
| `/etc/hlm-agent/agent.env` | `root:hlm-agent`, `0640` | Configuration et jeton |
| `/etc/systemd/system/hlm-agent.service` | `root` | Service durci : `ProtectSystem=strict`, aucune capacité, filtres d'appels système, 64 Mo de mémoire au maximum |
| `/usr/local/lib/hlm-agent/smart-collect.sh` | `root`, `0755` | Collecte SMART (lance seulement `smartctl`) |
| `/etc/systemd/system/hlm-agent-smart.{service,timer}` | `root` | Collecte SMART horaire, en root, **sans réseau** |
| `/var/lib/hlm-agent/smart/` | `root:hlm-agent`, `0750` | Résultats SMART lus par l'agent |

Root n'exécute jamais le binaire de l'agent : l'agent peut le réécrire pour se mettre à jour, ce qui ouvrirait une élévation de privilèges.

## Vérifier et dépanner

```sh
systemctl status hlm-agent
journalctl -u hlm-agent -n 50
systemctl list-timers hlm-agent-smart.timer
/opt/hlm-agent/hlm-agent --version
```

| Message dans le journal | Cause | Solution |
|---|---|---|
| `hub rejected TOKEN (401)` | Jeton erroné, révoqué ou régénéré | Régénérez le jeton depuis la fiche de l'hôte et réinstallez |
| `hub signature invalid: KEY does not match this hub` | `KEY` ne correspond pas à ce hub (autre instance, ou volume `/data` recréé) | Reprenez la clé affichée par le hub |
| `HUB_URL uses plain http` | Hub en HTTP sans `ALLOW_INSECURE=true` | Ajoutez-le, ou passez le hub en HTTPS |
| `connection timed out` | Hub injoignable depuis la machine | Pare-feu, DNS, port publié du conteneur |
| `update check failed` | Pas d'accès à github.com | Sans conséquence ; ou `AUTO_UPDATE=false` |

Le jeton d'un agent n'est valable que pour un hôte. Si deux machines utilisent le même, elles se déconnectent mutuellement : chaque nouvelle connexion remplace la précédente.
