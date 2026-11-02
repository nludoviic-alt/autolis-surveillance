# Surveillance Autolis

Contrôle extérieur d'[auto-lis.com](https://auto-lis.com) toutes les 5 minutes, depuis GitHub (hors du serveur surveillé).

| Contrôle | Adresse |
|---|---|
| Site | https://auto-lis.com/ |
| Santé (base + e-mails) | https://auto-lis.com/api/health |
| Admin | https://admin.auto-lis.com/healthz |

- Deux essais à 20 s d'intervalle avant de déclarer une panne.
- Panne : un ticket « 🔴 Autolis en panne » s'ouvre (étiquette `panne`) et un message Telegram part ; rappel toutes les 3 h.
- Retour : le ticket se ferme et un message Telegram donne la durée de la panne.

Réglages (Settings › Secrets and variables › Actions) : `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID`. Sans eux, seul le ticket GitHub (et son e-mail) prévient.

Essai à blanc en local, sans ticket ni message : `DRY_RUN=1 node scripts/check.mjs`
