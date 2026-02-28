# TheWootz — Bol.com Advertising API Koppeling

## Overzicht
Deze backend koppelt de bol.com Advertising API veilig aan de TheWootz optimizer tool.
De `client_secret` staat **alleen op de Vercel server** — nooit in de browser.

## Bestandsstructuur
```
thewootz-api/
├── api/
│   ├── token.js        ← OAuth2 token uitwisseling
│   ├── campaigns.js    ← Live campagne performance data
│   └── keywords.js     ← Zoekwoord-niveau analyse
├── public/
│   └── index.html      ← De volledige optimizer tool
├── vercel.json         ← Vercel routing configuratie
├── package.json        ← Node.js dependencies
└── README.md           ← Dit bestand
```

## Stap 1 — Bol.com API credentials ophalen

1. Ga naar [bol.com Partnerplatform](https://partnerplatform.bol.com)
2. Navigeer naar: **API** → **Mijn applicaties** → **Nieuwe applicatie aanmaken**
3. Kies scope: **Advertiser API**
4. Kopieer je `client_id` en `client_secret`

## Stap 2 — GitHub repository aanmaken

1. Maak een nieuw repository op [github.com](https://github.com)
2. Upload alle bestanden uit deze map (inclusief de `api/` submap)
3. Commit en push

## Stap 3 — Vercel deployment

### Optie A — Via de Vercel website (makkelijkst)
1. Ga naar [vercel.com](https://vercel.com) en log in
2. Klik **New Project** → importeer je GitHub repository
3. Vercel detecteert automatisch de configuratie
4. Klik **Deploy**

### Optie B — Via de CLI
```bash
npm install -g vercel
cd thewootz-api
vercel --prod
```

## Stap 4 — Environment Variables instellen

In je Vercel project → **Settings** → **Environment Variables**:

| Variabele          | Waarde                    |
|--------------------|---------------------------|
| `BOL_CLIENT_ID`    | jouw bol.com client_id    |
| `BOL_CLIENT_SECRET`| jouw bol.com client_secret|

⚠️ Klik na het toevoegen op **Redeploy** zodat de variabelen actief zijn.

## Stap 5 — Tool verbinden

1. Open de tool (je Vercel URL + `/public/index.html`, of direct als je Vercel static files serveert)
2. Vul je Vercel URL in de verbindingsbalk bovenaan
3. Klik **Verbinden**
4. Klaar — live data wordt geladen

## API Endpoints

| Endpoint          | Methode | Beschrijving                              |
|-------------------|---------|-------------------------------------------|
| `/api/token`      | POST    | Haal een OAuth access token op            |
| `/api/campaigns`  | GET     | Campagne performance data                 |
| `/api/keywords`   | GET     | Zoekwoord-niveau data per campagne        |

### Query parameters `/api/campaigns`
- `startDate` — YYYY-MM-DD (standaard: 30 dagen geleden)
- `endDate` — YYYY-MM-DD (standaard: vandaag)

### Query parameters `/api/keywords`
- `campaignId` — verplicht
- `startDate`, `endDate` — optioneel

## Veiligheid

- `client_secret` staat **alleen** in Vercel Environment Variables
- De frontend stuurt nooit credentials naar bol.com
- Tokens zijn tijdelijk (5 minuten) en worden automatisch ververst
- CORS is geconfigureerd voor de eigen Vercel URL

## Lokaal testen

```bash
npm install
vercel dev
```

De tool is dan beschikbaar op `http://localhost:3000`
