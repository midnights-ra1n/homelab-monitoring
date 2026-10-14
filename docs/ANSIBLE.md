# Ansible : intégrer l'agent à un playbook existant

Le rôle `hlm_agent` installe, met à jour ou supprime l'agent sur des machines Debian. Il lui suffit de trois variables : **l'adresse du hub, un jeton et la clé du hub**.

## 1. Récupérer le rôle

Dans le dossier de votre projet Ansible :

```sh
mkdir -p roles
curl -fsSL https://github.com/midnights-ra1n/homelab-monitoring/archive/refs/heads/stable.tar.gz \
  | tar -xz -C roles --strip-components=4 homelab-monitoring-stable/deploy/ansible/roles/hlm_agent
```

Le rôle se trouve alors dans `roles/hlm_agent`. Relancez la même commande pour le mettre à jour.

## 2. Choisir les jetons

La **clé** (`hlm_key`) est la clé publique du hub : elle est identique pour toutes les machines d'un même hub. Seul le **jeton** change selon la méthode.

| Méthode | Où le créer | Valeur de `hlm_agent_token` |
|---|---|---|
| **Jeton commun** (le plus simple) | *Hôtes → Déploiement en masse* | Le même `enr_…` pour toutes les machines. Chacune s'inscrit sous son nom à la première connexion et reçoit ensuite son propre jeton. |
| **Un jeton par machine** | *Hôtes → Ajouter un hôte*, une fois par machine | Le jeton propre à chaque machine, dans son `host_vars`. |

Les deux méthodes peuvent cohabiter : jeton commun dans `group_vars`, et un jeton particulier dans le `host_vars` des machines qui en ont un (la variable d'hôte l'emporte).

Avec le jeton commun, une machine qui s'est inscrite garde son jeton personnel. Vous pouvez laisser le jeton commun expirer ou le révoquer après le déploiement : les machines déjà inscrites continuent de fonctionner. Il ne resservira que pour ajouter de nouvelles machines.

## 3. Ajouter les variables

### Jeton commun pour un groupe

```yaml
# group_vars/homelab/main.yml
hlm_hub_url: https://monitoring.example.fr
hlm_key: "MCowBQYDK2VwAyEA…"                       # clé du hub
hlm_agent_token: "{{ vault_hlm_agent_token }}"
```

```sh
ansible-vault create group_vars/homelab/vault.yml
```

```yaml
# group_vars/homelab/vault.yml (chiffré)
vault_hlm_agent_token: enr_xxxxxxxxxxxxxxxx
```

### Jetons créés à la main, un par machine

```yaml
# host_vars/nas.lan.yml (chiffrez-le : ansible-vault encrypt host_vars/nas.lan.yml)
hlm_agent_token: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd
```

`hlm_hub_url` et `hlm_key` restent dans `group_vars`, puisqu'ils sont communs.

### Plusieurs hubs

Un groupe par hub, chacun avec sa propre adresse, sa clé et son jeton :

```yaml
# group_vars/site_paris/main.yml
hlm_hub_url: https://monitoring-paris.example.fr
hlm_key: "clé du hub de Paris"
hlm_agent_token: "{{ vault_hlm_token_paris }}"
```

### Variables d'environnement plutôt qu'un vault

```yaml
hlm_agent_token: "{{ lookup('ansible.builtin.env', 'HLM_AGENT_TOKEN') }}"
hlm_key: "{{ lookup('ansible.builtin.env', 'HLM_KEY') }}"
```

```sh
HLM_AGENT_TOKEN=enr_xxx HLM_KEY='MCow…' ansible-playbook site.yml
```

Pratique en CI, où le secret vient du gestionnaire de secrets de la plateforme.

## 4. Appeler le rôle

**Dans une play existante**, en l'ajoutant à ses rôles :

```yaml
- name: Serveurs du homelab
  hosts: homelab
  become: true
  roles:
    - common
    - docker
    - hlm_agent
```

**Au milieu de vos tâches** :

```yaml
- name: Installer l'agent de supervision
  ansible.builtin.include_role:
    name: hlm_agent
```

**Avec des valeurs locales** :

```yaml
- ansible.builtin.include_role:
    name: hlm_agent
  vars:
    hlm_smart: false           # pas de SMART sur ce groupe
    hlm_version: v0.1.4        # version figée (la mise à jour automatique est alors coupée)
```

Le rôle a besoin de `become: true` et des faits Ansible (`gather_facts`, actif par défaut).

## 5. Lancer

```sh
ansible-playbook site.yml --ask-vault-pass --check --diff   # aperçu, rien n'est modifié
ansible-playbook site.yml --ask-vault-pass
ansible-playbook site.yml --ask-vault-pass --limit nas.lan  # une seule machine
```

Le rôle est **idempotent** : un second passage affiche `changed=0`. L'agent ne redémarre que si son binaire, sa configuration ou son unité systemd change. Les jetons ne s'affichent jamais dans la sortie (`no_log`, pas de diff).

## 6. Désinstaller

```yaml
- ansible.builtin.include_role:
    name: hlm_agent
  vars:
    hlm_agent_state: absent
```

Le dépôt fournit aussi un playbook prêt à l'emploi : `ansible-playbook deploy/ansible/uninstall.yml --limit nas.lan`. Cela retire les services, le timer SMART, le binaire, la configuration, l'état et l'utilisateur `hlm-agent`. Supprimez ensuite l'hôte dans le tableau de bord ; sinon un agent encore muni du jeton commun s'y réinscrirait.

## Toutes les variables

| Variable | Défaut | Description |
|---|---|---|
| `hlm_agent_state` | `present` | `present` pour installer ou mettre à jour, `absent` pour tout supprimer |
| `hlm_hub_url` | — | Adresse du hub vue par les machines |
| `hlm_agent_token` | — | Jeton commun `enr_…` ou jeton de la machine |
| `hlm_key` | — | Clé publique du hub |
| `hlm_version` | `latest` | `latest` ou une release (`v0.1.4`) |
| `hlm_auto_update` | `true` avec `latest` | Mise à jour quotidienne par l'agent lui-même |
| `hlm_smart` | `false` sur VM et conteneur | Collecte SMART (installe smartmontools) |
| `hlm_allow_insecure` | `true` si `http://` | Accepter un hub en HTTP |
| `hlm_repo` | `midnights-ra1n/homelab-monitoring` | Dépôt des releases |

Le dossier `deploy/ansible/` du dépôt contient un exemple complet : `site.yml`, `uninstall.yml`, `inventory.example.ini`, `group_vars/monitored/main.example.yml`.
