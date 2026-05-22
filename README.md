# Destiny Lore Masters Clan Status

Web app statica per mostrare i membri del clan Destiny 2.

- Clan: `Destiny Lore Masters`
- Bungie Group ID usato dall'API: `5420062`
- Remote Group ID Bungie: `6761737`
- Nessun Firebase

## Pubblicazione su GitHub Pages

Carica tutta questa cartella in un repository GitHub.

Poi in GitHub:

1. Vai in `Settings > Pages`.
2. In `Build and deployment`, scegli `GitHub Actions`.
3. Fai push sul branch `main`.

Il workflow `.github/workflows/pages.yml` pubblicherà automaticamente il sito.

Su GitHub Pages la pagina legge `data/clan-status.json`, generato dalla GitHub
Action. Questo evita l'errore Bungie `OriginHeaderDoesNotMatchKey` che succede
quando il browser pubblico chiama direttamente `www.bungie.net`.

## Test locale

Per provarla in locale basta un server statico:

```powershell
cd C:\Users\gmeluzzi\Desktop\DLM
python -m http.server 8080
```

Poi apri:

```text
http://localhost:8080/
```

Il pulsante `Ricarica dati pubblicati` rilegge il file JSON statico generato dalla
GitHub Action; non chiama Bungie direttamente dal browser.

## Notifiche amici online

La cartella `worker/` contiene uno scaffold Cloudflare Worker per:

- login OAuth Bungie;
- lettura lista amici con `/Platform/Social/Friends/`;
- lettura dell'Hub Stagionale autenticato con `/api/seasonal-hub`;
- cron ogni 5 minuti;
- notifica Web Push quando un amico passa da offline a online.

GitHub Pages resta statico. Il Worker custodisce token Bungie e chiavi push.

Prima di usarlo devi:

1. creare una app Bungie con OAuth;
2. creare i KV namespace Cloudflare;
3. impostare i secret Worker;
4. fare deploy del Worker;
5. sostituire `WORKER_BASE_URL` in `index.html`.

I dettagli sono in `worker/README.md`.
