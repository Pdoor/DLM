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

Per provarla in locale usa il server incluso:

```powershell
cd C:\Users\gmeluzzi\Desktop\DLM
python server.py
```

Poi apri:

```text
http://localhost:8080/
```

Nota: non usare `python -m http.server`, perché Bungie rifiuta le chiamate dirette dal browser locale con `OriginHeaderDoesNotMatchKey`.
