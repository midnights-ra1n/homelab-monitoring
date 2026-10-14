J'aimerais me créer mon propre dashboard de monitoring homelab avec un agent à installer.

## Back-end

Je voudrais que ça fonctionne sous Go avec base de données SQLite. On aura un agent installé sur mes hôtes et qui vont se charger de collecter les métriques et les envoyer au serveur.
On va s'inspirer des trois projets pour avoir quelque chose de fonctionnel et de léger. Je ne veux pas qu'on vienne bouffer toutes les ressources du serveur où sera installé l'outil de monitoring, il faut que je puisse faire du ménage, avoir une rétention de données etc...
J'aimerais de même avoir un outil d'import et d'exports de paramètres et métriques.

Je voudrais (comme sur Status Page de Atlassian ou Better Uptime de BetterStack) avoir des états opérationnels, performances dégradés, maintenance, minor outage et major outage.
Je voudrais qu'on ai une intégration SMTP pour envoyer des notifications en cas de problème (pour information si ce sont plusieurs services qui tombent, ne pas envoyer de mail à chaque services tombés. Par exemple j'ai 15 services qui tombent en même temps je ne veux pas recevoir d'un coup 15 mails). Le mail devra être entièrement personnalisable via HTML ou même via un éditeur graphique.

### Serveur MCP

Je voudrais la possibilité d'un serveur MCP (activable ou désactivable) pour l'intégrer dans Claude et par exemple lui demander "est ce que j'ai un service innaccessible ?".

### Sécurité

Il faut évidemment quelque chose de très sécurisé que ce soit la partie serveur, l'API, le MCP, l'agent et la collecte de métriques (communication entre l'agent et le serveur). Il ne faut pas de failles de sécurité. Ajoute la prise en charge de passkeys (clés d'accès) uniquement si on est HTTPS et derrière un reverse proxy. 

### API

J'aimerais qu'on créé une API ouverte qui serait faite en Rust et capable (via token) de donner nos métriques à un autre dashboard (car pour information j'ai aussi un autre dashboard pour homelab mais qui me sert de management et je voudrais l'intégrer aussi à ce dashboard). Documente bien cette API dans un .md pour que je puisse l'intégrer facilement dans mon projet de gestion de homelab.

## Front-end

Le front end sera en React avec une belle interface (pour l'interface je voudrais que tu regarde dans le fichier "Midnights Classic design system.pdf" et aussi en incluant dans les paramètres un thème "Midnights Mint" qui sera sur https://noe-georget.fr/graphique qui comprendrons toutes les directives). Cette interface devra être belle, accessible et optimisée pour mobile car je compte en faire un PWA.
Dans le dashboard (et même la page de status publique) je voudrais qu'on ai la possibilité de tout personnaliser de la manière la plus simple possible (qu'on puisse mettre des graphs, un historique sur 90 jours...)... Ajoute aussi quelques graphs de latence...

## Agent

L'agent sera fait en Rust.
Ce sera un petit agent qui s'installera sur machines virtuelles, serveurs Proxmox, serveurs physiques et mêmes machines clientes. On devra notamment collecter :
- Informations sur le matériel (CPU, RAM, stockage, températures etc...)
- Des graphiques sur l'usage matériel
- Des graphiques sur la bande passante du réseau
- Des informations sur les services systemd
- Des informations sur les mises à jour (si des mises à jour sont disponibles, programmation des mises à jour de manière automatique et programmation des redémarrages)
- Des informations sur Docker (conteneurs en exécution, consommation des ressources par conteneurs...)
- Des informations sur les mises à jour de conteneurs Docker et également (pas que pour Docker, la surveillance de CVE/vulnérabilités/failles de sécurité)
Pour la collecte des métriques je voudrais une collecte très légère en direct et qui ne va pas saturer les ressources du VPS/serveur distant de monitoring.

Je voudrais que l'agent soit aussi optimisé pour un déploiement de masse et headless avec Ansible. Cet agent sera aussi un service systemd qui devra se lancer automatiquement au démarrage et démarrer instantanéement. Aussi pour communiquer avec le serveur je voudrais que ce soit pareil qu'avec Beszel. L'agent sera un binaire qui se mettra à jour automatiquement chaque jour (si une mise à jour est détectée)

## Fonctionnalités à implémenter dans l'interface web
On va devoir s'inspirer un peu de Beszel (https://beszel.dev/), Maintenant (https://github.com/kolapsis/maintenant) et Patchmon (https://github.com/PatchMon/PatchMon). L'ensemble de ces outils sont majoritairement faits en Golang. Je voudrais un bouton pour ajouter un hôte ou bien une sonde qui va permettre de surveiller :
- Endpoint HTTP / TCP
- Ajout de nom de domaine et surveillance de l'expiration du certificat SSL
- Ajout de surveillance de serveurs DNS

Je voudrais qu'on ai la possibilité de créer une page de statut publique.
