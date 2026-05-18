# DLM Notify Worker

Cloudflare Worker per login Bungie, monitoraggio amici online e notifiche Web Push.

## Setup Cloudflare

Installa dipendenze:

```powershell
cd C:\Users\gmeluzzi\Desktop\DLM\worker
npm install
```

Crea 4 KV namespace:

```powershell
npx wrangler kv namespace create DLM_USERS
npx wrangler kv namespace create DLM_OAUTH_STATES
npx wrangler kv namespace create DLM_PUSH_SUBSCRIPTIONS
npx wrangler kv namespace create DLM_PRESENCE
```

Sostituisci gli `id` generati in `wrangler.toml`.

## Bungie App

Crea/configura una app su Bungie.net e abilita OAuth.

Redirect URL:

```text
https://<tuo-worker>.workers.dev/auth/callback
```

Origin per la webapp:

```text
https://pdoor.github.io
```

Scope richiesto:

```text
ReadUserData
```

## Secret Worker

Genera chiavi VAPID:

```powershell
npx web-push generate-vapid-keys
```

Imposta secret:

```powershell
npx wrangler secret put BUNGIE_API_KEY
npx wrangler secret put BUNGIE_CLIENT_ID
npx wrangler secret put BUNGIE_CLIENT_SECRET
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put ADMIN_SECRET
```

Variabili non segrete in Cloudflare Worker:

```text
FRONTEND_URL=https://pdoor.github.io/DLM/
```

`VAPID_SUBJECT` può essere:

```text
mailto:tua-email@example.com
```

## Deploy

```powershell
npx wrangler deploy
```

Dopo il deploy, aggiorna in `index.html`:

```js
const WORKER_BASE_URL = 'https://<tuo-worker>.workers.dev';
```

Poi fai commit e push della webapp.
