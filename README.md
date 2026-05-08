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
