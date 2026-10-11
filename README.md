![GitHub License](https://img.shields.io/github/license/ScoutingScherpenzeel/jotihunt-tracker-server) 
![GitHub branch status](https://img.shields.io/github/checks-status/ScoutingScherpenzeel/jotihunt-tracker-server/main)
![GitHub Release](https://img.shields.io/github/v/release/ScoutingScherpenzeel/jotihunt-tracker-server)

---

<img width="978" height="618" alt="Jotihunt Tracker (2)" src="https://github.com/user-attachments/assets/b8efdac6-1beb-40f7-b627-4ec540a4a0d2" />

# 🦊 Jotihunt Tracker - Server
Volg met gemak de locaties van vossenteams, hunts, hints en hunters tijdens de Jotihunt!
Met deze server-app heb je een kant-en-klare backend om de voortgang live te volgen en direct op de hoogte te blijven van alle ontwikkelingen.

> [!NOTE]
> Werkt het beste in combinatie met de [Jotihunt Tracker Client](https://github.com/ScoutingScherpenzeel/jotihunt-tracker-client).

## Features:
- Real-time locaties van hunters.
- Registreren van hints.
- Aanmaken van spots en hunt locaties.
- Status updates van vossenteams (rood, oranje, groen).
- Ophalen en opslaan van teams vanuit Jotihunt API.
- Ophalen en opslaan van gepubliceerde hints en opdrachten vanuit Jotihunt API.
- Integratie met Traccar GPS tracking server.
- Eenvoudige authenticatie.
- Gebruikersbeheer met verschillende rollen (admin, gebruiker).

## 🚀 Gebruik
Je bent volledig vrij om deze tracker te gebruiken (het is ten slotte open-source). We zouden het echter enorm waarderen als je ons als bron vermeldt wanneer je dat doet.
Laat het ons vooral weten als je de tracker inzet tijdens jullie Jotihunt, we vinden het superleuk om te horen hoe hij in het veld wordt gebruikt! 😄

> [!TIP]
> Bekijk ook de [Jotihunt Discord Notifier](https://github.com/ScoutingScherpenzeel/jotihunt-discord-notifier) en [Jotihunt Telegram Forwarder](https://github.com/ScoutingScherpenzeel/jotihunt-telegram-forwarder) voor het automatisch ophalen en sturen van hints en opdrachten én het doorsturen van berichten uit Telegram in een Discord-server.

## 🛠️ Installatie
Deze backend werkt het beste in combinatie met de [Jotihunt Tracker Client](https://github.com/ScoutingScherpenzeel/jotihunt-tracker-client. De client niet gebruiken kan, maar wordt niet aanbevolen en is geen rekening mee gehouden in de code.
Om de complete app te gebruiken, kun je het beste gebruik maken van [Docker](https://www.docker.com/). Onderstaande installatie zorgt ook voor een [Traccar](https://www.traccar.org/) server, welke je later zelf nog dient te configureren.
Traccar is de GPS tracker die gebruikt wordt op de telefoons van de hunters.

### Docker compose
1. Maak een bestand `docker-compose.yml` aan met de volgende inhoud:
```yaml
version: "3.9"
services:
  server:
    image: ghcr.io/scoutingscherpenzeel/jotihunt-tracker-server:latest # of ":main" voor de laatste ontwikkelversie.
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "3000:3000"
    volumes:
      - uploads:/usr/src/app/uploads
  client:
    image: ghcr.io/scoutingscherpenzeel/jotihunt-tracker-client:latest
    restart: unless-stopped
    ports:
      - "80:80"
    env_file:
      - .env
  mongodb:
    image: mongo:latest
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - mongodb:/data/db
  traccar:
    image: traccar/traccar:ubuntu
    restart: unless-stopped
    ports:
      - 5055:5055 # UDP poort voor GPS trackers
      - 8082:8082 # Webinterface en API
    volumes:
      - traccar_logs:/opt/traccar/logs
      - traccar_data:/opt/traccar/data
      - traccar_conf:/opt/traccar/conf
      
volumes:
  mongodb:
  traccar_logs:
  traccar_data:
  traccar_conf:
  uploads:
```
2. Maak in dezelfde folder een `.env` bestand aan met de volgende inhoud (zie ook: configuratie):
```env
DEBUG=false
TZ=Europe/Amsterdam

# Database
MONGO_URI=mongodb://mongodb:27017/jotihunt
MONGO_INITDB_DATABASE=jotihunt

# Traccar
TRACCAR_API_URL=http://traccar:8082
TRACCAR_API_TOKEN=token-van-traccar
TRACCAR_CLIENT_URL=http://tracker.jotihunt.jouwscoutinggroep.nl:5055 # Adres voor de Traccar Client-app (QR-code in "Mijn tracker")
JOTIHUNT_API_URL=https://jotihunt.nl/api/2.0

# Jotihunt
JOTIHUNT_WEB_URL=https://jotihunt.nl
JOTIHUNT_WEB_USERNAME=naam@jouwscoutinggroep.nl
JOTIHUNT_WEB_PASSWORD=password123
HUNT_START_TIME=2025-10-18T10:00+02:00 # Pas dit aan naar de starttijd van de hunt van dat jaar.
HUNT_END_TIME=2025-10-19T12:00+02:00 # Pas dit aan naar de eindtijd van de hunt van dat jaar.
ORS_API_KEY= # Optioneel, voor de vossenvoorspelling (zie configuratie)
GEMINI_API_KEY= # Optioneel, leest huntcode en tijd van de huntfoto en voorspelt de vossen (zie configuratie)
GEMINI_MODEL=gemini-3.8-flash
GEMINI_PREDICTION_MODEL=gemini-pro-latest
GEMINI_CHAT_MODEL=gemini-3.8-flash

# Client
JWT_SECRET=verander-dit-naar-een-veilige-random-string-van-minimaal-32-tekens
API_BASE_URL=https://api.jotihunt.jouwscoutinggroep.nl
MAPBOX_TOKEN=jouw-mapbox-token-hier
HOME_TEAM_API_ID=17
GROUP_WALKING_ID=3
GROUP_CAR_ID=2
GROUP_MOTORCYCLE_ID=4
GROUP_BIKE_ID=5
DISCORD_URL=https://discord.gg/jouw-discord-server # Optioneel
GROUP_NAME=Jouw Scoutinggroep # Optioneel
LOGO_URL=https://jouwscoutinggroep.nl/logo.png # Optioneel
TEAMS_AREA_EDITING=false # Sta toe dat gebruikers de teams-gebieden kunnen aanpassen in de client
TRUST_PROXY= # Optioneel, zet bijvoorbeeld op 1 achter een reverse proxy, zodat de limieten per IP-adres (inloggen en app koppelen) het echte clientadres zien
```
3. Start de applicatie met:
```bash
docker-compose up -d
```

Er zijn nu vier services gestart:
- `server`: De Jotihunt Tracker Server - http://localhost:3000
- `client`: De Jotihunt Tracker Client - http://localhost:80
- `traccar`: De Traccar GPS tracking server - http://localhost:8082
- `mongodb`: De MongoDB database voor de server

## ⚙️ Configuratie
Volg de configuratiestappen om de volledige applicatie werkend te krijgen.

### Omgevingsvariabelen
De applicatie kan worden geconfigureerd via omgevingsvariabelen. Hieronder volgt een overzicht van waar je de verschillende variabelen vandaan kunt halen.
#### `TRACCAR_API_TOKEN`
1. Ga naar jouw Traccar server (standaard te bereiken via `http://localhost:8082`) en log in als administrator. De token moet van een beheerder zijn: de server maakt hiermee de apparaten van de gebruikers aan.
2. Navigeer onderin naar `Instellingen` > `Voorkeuren` > `Token`.
3. Stel een verloopdatum in en druk op de ververs knop.
4. Kopieer de gegenereerde token en plak deze in de `.env` file bij `TRACCAR_API_TOKEN`.

#### `TRACCAR_CLIENT_URL`
Het adres waar de Traccar Client-app op de telefoons de locaties naartoe stuurt: jouw Traccar server op poort `5055`, bijvoorbeeld `http://tracker.jotihunt.jouwscoutinggroep.nl:5055`.
Dit adres komt in de QR-code van de kaart "Mijn tracker" in de zijbalk. Is het niet ingevuld (of ontbreken `TRACCAR_API_URL`/`TRACCAR_API_TOKEN`), dan toont de kaart "Live tracking is nog niet ingesteld".
Lokaal testen met een telefoon in hetzelfde wifi-netwerk: gebruik het LAN-adres van je computer, bijvoorbeeld `http://192.168.1.10:5055`.

#### `JOTIHUNT_WEB_USERNAME` en `JOTIHUNT_WEB_PASSWORD`
Dit zijn de inloggegevens die je normaal gebruikt om in te loggen op [jotihunt.nl](https://jotihunt.nl). De server zal deze gebruiken om automatisch de hunts op te halen (scrapen).

#### `HUNT_START_TIME` en `HUNT_END_TIME`
Stel hier de start- en eindtijd van de hunt in. Let goed op de juiste tijdzone (bijv. `+02:00` voor Nederland tijdens zomertijd).

#### `ORS_API_KEY` (optioneel)
Wordt gebruikt door de vossenvoorspelling voor looptijden naar de groepen via [OpenRouteService](https://openrouteservice.org/).
1. Maak een gratis account aan op [openrouteservice.org](https://openrouteservice.org/dev/#/signup).
2. Maak in het dashboard een (gratis) token aan.
3. Plak de key in de `.env` file bij `ORS_API_KEY`.

Zonder key gebruikt de voorspelling rechte-lijn-schattingen (rechte lijn × 1,3 bij 5 km/u). Er worden alleen coördinaten verstuurd, geen persoonsgegevens.

#### `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_PREDICTION_MODEL` en `GEMINI_CHAT_MODEL` (optioneel)
De server leest de huntcode en de handgeschreven tijd van de huntfoto met [Google Gemini](https://ai.google.dev/). Hunters hoeven dan alleen een foto te maken en de vossengroep te kiezen.
1. Maak een API-key aan in [Google AI Studio](https://aistudio.google.com/apikey).
2. Plak de key in de `.env` file bij `GEMINI_API_KEY`. `GEMINI_MODEL` is optioneel (standaard `gemini-3.8-flash`).
3. De vossenvoorspelling gebruikt hetzelfde key en het model `GEMINI_PREDICTION_MODEL` (standaard `gemini-pro-latest`).
4. De Gemini-assistent op de hintpagina gebruikt `GEMINI_CHAT_MODEL` (standaard `gemini-3.8-flash`).
5. Nieuws en opdrachten krijgen automatisch een korte samenvatting met `GEMINI_MODEL`; de tekst van die artikelen wordt daarvoor naar Google gestuurd.

Het lezen gebeurt op de achtergrond, één foto tegelijk (bij netwerkfouten of drukte tot 3 pogingen). Is de code of tijd niet (zeker) gelezen, dan krijgt de hunt het label "Controleren" en kan HQ de waarden aanpassen of opnieuw laten lezen. Zonder key worden foto's niet gelezen en vult HQ code en tijd zelf in.

**Vossenvoorspelling:** Gemini krijgt per vossengebied het spoor van markers (hints, spots, hunts) en de coördinaten van de groepen, en voorspelt daaruit een pin, de ronde en een korte uitleg. Dat kost ongeveer één Gemini Pro-aanroep per actief gebied per 10 minuten (of eerder bij nieuwe gegevens), altijd na elkaar (nooit tegelijk). Zonder `GEMINI_API_KEY` staat de vossenvoorspelling uit. Een admin kan de voorspelling ook helemaal uit- en aanzetten via Instellingen > Admin tools > "AI-voorspelling" (globaal, bewaard in de `settings` collectie; uit betekent geen Gemini/ORS-aanroepen en geen voorspellingen of bezoeken in de app).

**Privacy:** de huntfoto's, het markerspoor en de coördinaten van de groepen worden naar Google gestuurd. Met een gratis (free tier) key mag Google de verstuurde gegevens gebruiken om hun producten te verbeteren; gebruik een betaalde key als je dat niet wilt. De key komt nooit in de logs of in antwoorden van de server.

#### `JWT_SECRET`
Genereer een willekeurige, veilige string van minimaal 32 tekens. Deze wordt gebruikt om JWT tokens te ondertekenen voor de authenticatie.

#### `MAPBOX_TOKEN`
1. Maak een account aan op [Mapbox](https://www.mapbox.com/).
2. Volg de instructies [hier](https://docs.mapbox.com/help/dive-deeper/access-tokens/) om een token te genereren.
3. Standaard heeft je account 50.000 gratis kaartweergaven per maand. Tenzij je van plan bent 600 terminator AI-agents in te schakelen, zou dit voldoende moeten zijn.
4. Kopieer de token en plak deze in de `.env` file bij `MAPBOX_TOKEN`.

#### `API_BASE_URL`
Stel dit in op de URL waar jouw Jotihunt Tracker Server bereikbaar is. Bijvoorbeeld `https://api.jotihunt.jouwscoutinggroep.nl` of `http://localhost:3000` als je lokaal werkt.
Belangrijk: deze URL moet **publiek toegankelijk** zijn.

#### `HOME_TEAM_API_ID`
Dit is de API ID van jouw eigen team op de Jotihunt website. Deze kun je pas invullen nadat je bent aangemeld.
1. Ga naar `https://jotihunt.nl/api/2.0/subscriptions` en zoek jouw team op in de lijst.
2. Noteer de `id` waarde van jouw team en vul deze in bij `HOME_TEAM_API_ID` in de `.env` file.

#### `GROUP_WALKING_ID`, `GROUP_CAR_ID`, `GROUP_MOTORCYCLE_ID`, `GROUP_BIKE_ID`
Deze waarden komen overeen met de groeps-ID's die door Traccar worden gebruikt om verschillende soorten voertuigen te onderscheiden.
1. Ga naar jouw Traccar server (standaard te bereiken via `http://localhost:8082`) en log in als administrator.
2. Navigeer onderin naar `Instellingen` > `Groepen`.
3. Maak hier de verschillende groepen aan: `Auto`, `Fiets`, `Motor`, `Lopend`.
4. Voor elke groep zie je in het bewerkscherm in de URL het juiste ID staan. (bijv. bij https://traccar.jotihunt.jouwscoutinggroep.nl/settings/group/2 is het id `2`).
5. Vul deze ID's in bij de respectievelijke omgevingsvariabelen in de `.env` file.

#### `DISCORD_URL`
Optioneel: vul hier de URL in van jouw Discord-server. Er zal dan een knop verschijnen in de client waarmee gebruikers direct kunnen joinen.

#### `TEAMS_AREA_EDITING`
In 2024 waren de deelgebieden niet voorafgaand aan de hunt bekend.
Door deze instelling op `true` te zetten, kunnen gebruikers in de client de gebieden van teams zelf aanpassen en opslaan.

### Eerste gebruiker aanmaken
Als je voor het eerst wilt inloggen, zul je een beheerder account moeten aanmaken.
Dit kan alleen direct vanuit de docker container. Zoek de naam van de draaiende server container op met:
```bash
docker ps
```
Vervolgens voer je het volgende commando uit (vervang `jotihunt-server-1` door de naam van jouw container):
```bash
docker exec -it jotihunt-server-1 bun run create-user --email mail@jouwscoutinggroep.nl --password wachtwoord --name Naam --admin true
```

### Ophalen teams uit API
De kaart is in eerste instantie nog leeg. Om de teams op te halen, ga je met een beheerderaccount naar `Instellingen` > `Admin tools` en druk je op de knop `Herlaad teams uit API`.
Hierna wordt de kaart gevuld met de teams die meedoen aan de Jotihunt. Vergeet dit niet uit te voeren nadat de inschrijving is gesloten!
## 🛰️ GPS Tracking
De GPS tracking wordt verzorgd door [Traccar](https://www.traccar.org/).
Om de GPS tracking werkend te krijgen, dien je de telefoons van de hunters te configureren met de Traccar Client app.

**Makkelijkste manier:** iedere gebruiker ziet in de zijbalk de kaart "Mijn tracker" met een persoonlijke QR-code. Installeer de Traccar Client-app, scan de code in de app (of tik op een telefoon op "Open in Traccar-app") en zet "Continu volgen" aan. De server maakt het apparaat in Traccar zelf aan, zet het in de groep van het gekozen voertuig (Lopend / Fiets / Auto / Motor) en de kaart toont "Verbonden ✓" zodra de eerste locatie binnen is. Hiervoor moeten `TRACCAR_CLIENT_URL` en de `GROUP_*_ID`'s ingevuld zijn.

Handmatig instellen kan ook:
1. Installeer de [Traccar Client app](https://www.traccar.org/client/) op de telefoons van de hunters. De apps zijn verkrijgbaar in zowel de Play Store als de App Store.
2. Open de app en ga naar `Instellingen wijzigen`.
3. De volgende instellingen werken goed in de meeste gevallen:
    - Server-URL: Dit is de URL van jouw Traccar server, bijvoorbeeld `http://tracker.jotihunt.jouwscoutinggroep.nl`. Let op: deze URL moet naar poort `5055` gaan!
    - Locatienauwkeurigheid: Hoogste
    - Afstand (meters): 5
    - Interval (seconden): 5
    - Hoek (graden): Uitgeschakeld
    - Stationaire heartbeat (seconden): 30
    - Snelste interval (seconden): 5
    - Offline buffering: Ingeschakeld
    - Wakelock: Ingeschakeld
    - Stopdetectie: Ingeschakeld
4. Je kan ook gebruik maken van een QR-code om de instellingen te configureren. Dat ziet er dan als volgt uit: `https://tracker.jotihunt.jouwscoutinggroep.nl/?accuracy=highest&distance=5&heartbeat=30&fastest_interval=5&interval=5&wakelock=true`

In het dashboard dien je als beheerder vervolgens het Apparaat-ID te registreren. Dit doe je door in de zijbalk bovenin op het plusje (+) te drukken en de gegevens van het apparaat in te vullen. Na opslaan zal het apparaat verschijnen in de lijst en zal de GPS tracking starten zodra de app op de telefoon wordt gestart met "Continu volgen".

## 📸 Hunts registreren
Hunters registreren een hunt met een foto vanaf hun telefoon, plus de vossengroep en de soort (hunt/tegenhunt). De server leest de huntcode (hoofdlettergevoelig) en de handgeschreven tijd van de foto met Gemini (zie `GEMINI_API_KEY`); tot de tijd gelezen is geldt het uploadtijdstip. Dubbele codes worden niet geweigerd maar gemarkeerd. HQ (admins) kan code en tijd corrigeren en een foto opnieuw laten lezen. De foto's staan in de map `uploads` (in Docker het volume `uploads`, het pad is aan te passen met de omgevingsvariabele `UPLOADS_DIR`). HQ stuurt de hunt zelf in op jotihunt.nl en klikt daarna in de tracker op "Ingestuurd" om dat bij te houden.

### Android-app

De APK van de Android-app en een bestand `latest.json` (`{ "versionCode": 1, "versionName": "1.0.0", "file": "jotihunt-1.0.0.apk", "sha256": "<hex>" }`) staan in de map `app-releases` (aan te passen met `APP_DIR`; in Docker een bind mount). De server serveert ze zonder inloggen op `GET /app/latest` en `GET /app/download/<bestand>`. De site toont de downloadknop zodra `GET /app/latest` antwoordt.

**Let op:** het koppelen en ontkoppelen van telefoons terwijl demomodus aan staat blijft niet bewaard nadat demomodus is uitgezet (apparaten staan op het gebruikersrecord en demo kopieert de gebruikers). Koppel en ontkoppel dus buiten demomodus.

## 🤝 Bijdragen
- Heb je zelf verbeteringen gemaakt? Open een Pull Request!
- Ideeën maar geen code-skills? Maak een Issue, wie weet pakt iemand het op.
- Alle bijdragen zijn welkom om de tracker samen nóg beter te maken. 💡

## 📜 Licentie
Dit project is open-source en beschikbaar onder de MIT-licentie.

💛 Gemaakt door [Scouting Scherpenzeel](https://scoutingscherpenzeel.nl/).\
📧 E-mailadres: [info@scoutingscherpenzeel.nl](mailto:info@scoutingscherpenzeel.nl)