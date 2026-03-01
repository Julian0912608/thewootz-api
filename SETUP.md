# TheWootz SaaS v2.0 — Setup Gids

## Wat zit er in dit pakket?

```
thewootz-saas/
├── api/
│   ├── _lib/supabase.js      ← Gedeelde helpers
│   ├── auth.js               ← Register + Login
│   ├── stores.js             ← Winkels beheren
│   ├── dashboard.js          ← Dashboard data (uit DB)
│   ├── sync/bol.js           ← Bol.com sync (FIX voor 48u probleem)
│   └── cron/sync-orders.js   ← Nachtelijke automatische sync
├── public/
│   ├── index.html            ← Responsive frontend
│   └── app.js                ← Alle JavaScript
├── supabase_schema.sql       ← Database schema (run dit 1x)
├── package.json
├── vercel.json               ← Cron configuratie
└── SETUP.md                  ← Dit bestand
```

---

## Stap 1 — Supabase project aanmaken

1. Ga naar **https://supabase.com** en maak een gratis account
2. Maak een nieuw project (kies een wachtwoord, regio: Frankfurt)
3. Wacht ~2 minuten tot het project klaar is
4. Ga naar **Settings → API**
5. Noteer de volgende waardes:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public key** → begint met `eyJ...`
   - **service_role key** → begint met `eyJ...` (GEHEIM — nooit in frontend!)

---

## Stap 2 — Database schema uitvoeren

1. Ga naar **SQL Editor** in het Supabase dashboard
2. Klik **New Query**
3. Kopieer de volledige inhoud van `supabase_schema.sql`
4. Plak en klik **Run**
5. Je ziet: `Success. No rows returned`

Dit maakt de tabellen aan: `profiles`, `stores`, `orders`, `order_items`, `sync_log`

**Optioneel: Email verificatie uitschakelen (voor development)**
- Ga naar **Authentication → Providers → Email**
- Zet "Confirm email" UIT
- Dan kunnen gebruikers direct inloggen zonder emailbevestiging

---

## Stap 3 — Vercel environment variables instellen

1. Ga naar je Vercel dashboard → project **thewootz-api**
2. Ga naar **Settings → Environment Variables**
3. Voeg de volgende variabelen toe:

| Naam | Waarde |
|------|--------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | `eyJ...` (anon key) |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role key) |
| `CRON_SECRET` | Een willekeurig sterk wachtwoord (bijv: `tw_cron_abc123xyz789`) |

---

## Stap 4 — Backend deployen

### Via GitHub (aanbevolen):
1. Push de `api/` folder + `package.json` + `vercel.json` naar je GitHub repo
2. Vercel detecteert automatisch de wijzigingen en deployt

### Handmatig via Vercel CLI:
```bash
vercel --prod
```

---

## Stap 5 — Frontend deployen

### Optie A: Zet de `public/` folder in je bestaande GitHub repo
```
thewootz-api/
├── api/
├── public/          ← voeg dit toe
│   ├── index.html
│   └── app.js
└── vercel.json
```

Vercel serveert automatisch bestanden uit de `public/` folder.

### Optie B: Aparte repo voor de frontend
- Maak een nieuwe Vercel deployment alleen met `public/index.html` en `public/app.js`

---

## Stap 6 — Testen

1. Open je frontend URL
2. Maak een account aan
3. Ga naar **Mijn Winkels** en koppel je bol.com account
4. Klik **Nu synchroniseren** (volledige sync van 90 dagen)
5. Ga naar **Sales Dashboard** — je ziet nu alle historische bestellingen!

---

## Hoe de Bol.com data fix werkt

**Het probleem:**
Bol.com's API toont orders na verzending maar 48 uur lang. Daarna verdwijnen ze.

**Onze oplossing:**
1. Bij eerste koppeling: volledige sync van 90 dagen via `latest-change-date` parameter
2. Elke nacht om 02:00: automatische sync van de laatste 2 dagen (Vercel Cron)
3. Data wordt opgeslagen in Supabase — permanent beschikbaar
4. Dashboard leest uit onze eigen database, niet direct van bol.com API

**Resultaat:** Je ziet altijd 100% van je bestellingen, ook die van 6 weken geleden.

---

## Volgende stappen (roadmap)

- [ ] Responsive ✅ (al ingebouwd)
- [ ] Accounts + database ✅ (dit pakket)
- [ ] Bol.com data fix ✅ (dit pakket)
- [ ] Etsy integratie (volgende sprint)
- [ ] Amazon integratie (daarna)
- [ ] Pinterest ads (daarna)
- [ ] Multi-platform vergelijking dashboard

---

## Vragen?

Alle API endpoints:
- `POST /api/auth` — register/login/logout
- `GET/POST/DELETE /api/stores` — winkels beheren
- `POST /api/sync/bol` — bol.com data synchroniseren
- `GET /api/dashboard` — dashboard data ophalen
- `GET /api/cron/sync-orders` — nachtelijke cron (alleen via Vercel)
