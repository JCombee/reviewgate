# ReviewGate — implementatieplan

Een lokale, browser-gebaseerde code review gate die opent zodra Claude Code wil committen.
GitLab-MR-achtige review: globale comments, comments op regel/regelbereik, een chatpaneel over
de changes, en één actieknop die wisselt tussen **Approve** en **Request changes**.

Dit document is bedoeld als werkplan voor Claude Code. Lees het volledig voor je begint,
werk per milestone, en commit per afgeronde milestone (de gate reviewt zichzelf zodra M3 draait).

---

## 1. Doel en scope

### Wel

- Claude Code kan niet committen zonder dat er een menselijke beslissing is geweest.
- De diff wordt gepresenteerd in een browser-UI met syntax highlighting, unified en split view.
- Comments: globaal (op de hele review) en op regelniveau (enkele regel of gesleepte range),
  op zowel de oude als de nieuwe kant van de diff.
- Threads per comment, met resolve/unresolve, precies zoals GitLab discussions.
- Chatpaneel naast de diff om vragen te stellen over de changes, met toegang tot de repo
  en tot het transcript van de sessie die de code schreef.
- Eén primaire actieknop: **Approve** bij nul openstaande comments, die verandert in
  **Request changes** zodra er minstens één openstaande comment is.
- Bij Request changes komt alle feedback gestructureerd terug in de Claude Code sessie,
  die daarna de fixes doet en opnieuw probeert te committen (ronde 2 van dezelfde review).

### Niet (voorlopig)

- Geen remote/multi-user reviews, geen hosting, geen accounts. Alles is localhost, één gebruiker.
- Geen GitHub/GitLab API-integratie. Wel als expliciet non-goal opschrijven zodat het datamodel
  er later niet omheen gebouwd hoeft te worden.
- Geen editing van code in de UI. De UI produceert feedback; de agent past aan. De commit
  message is de enige uitzondering: die is wel bewerkbaar (§8).
- Alleen `git commit` is een gate. `git push` niet — als het commit-moment gedekt is, voegt een
  tweede gate op push weinig toe en zit hij vooral in de weg bij branches die je zelf al hebt
  gereviewd.
- Geen git-native `pre-commit` hook in `.git/hooks/`. Commits die jij zelf vanuit de terminal
  maakt gaan ongehinderd door; de gate bewaakt de agent, niet jou.
- Geen ondersteuning voor andere agents (Cursor, Codex) in v1, maar de kern (CLI + server + UI)
  moet agent-agnostisch blijven zodat dat later een tweede adapter is.

---

## 2. Kernbeslissing: hoe de gate werkt

De hele tool hangt aan één keuze: **de PreToolUse hook blokkeert synchroon**.

De hook start de review-server, opent de browser, en blijft wachten tot er in de UI een
beslissing valt. Daarna geeft hij een verdict terug aan Claude Code:

| Beslissing in de UI     | Hook output                                                                | Gevolg                                           |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Approve                 | `permissionDecision: "allow"`                                              | het `git commit` commando loopt gewoon door      |
| Request changes         | `permissionDecision: "deny"` + alle feedback in `permissionDecisionReason` | Claude ziet de review als feedback en gaat fixen |
| Timeout / browser dicht | `deny` met korte uitleg                                                    | Claude wacht op de gebruiker, commit niet        |

Waarom synchroon en niet asynchroon (hook zegt "open de viewer en poll maar"):

- Geen extra ronde door het model nodig; er kan niets tussen vallen.
- De feedback komt exact op de plek terecht waar Claude erop moet reageren.
- Een `deny` van een PreToolUse hook geldt in élke permission mode, ook onder
  `--dangerously-skip-permissions`. De gate is dus niet te omzeilen door de agent.

Let op de timeout: PreToolUse hooks hebben standaard 600 seconden. Dat is te kort voor een
echte review. Zet in `hooks.json` expliciet `"timeout": 3600` en maak dat configureerbaar.

### Hook contract

De hook krijgt JSON op stdin met onder andere `tool_name`, `tool_input.command`, `cwd`,
`session_id` en `transcript_path`. Verifieer die veldnamen tegen de actuele docs
(https://code.claude.com/docs/en/hooks) voor je erop bouwt; het transcriptpad is belangrijk,
want dat voedt het chatpaneel (zie §9).

Output op stdout, exit 0:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<gerenderde review-feedback in markdown>"
  }
}
```

### Wanneer de hook wél en niet triggert

Matcher is `Bash`. In het script zelf filteren op het commando:

- Trigger op `git commit`, inclusief `-m`, `-am`, `--amend`.
- Trigger óók als het commando een `&&`-keten is die op een commit uitkomt
  (`git add -A && git commit -m "..."`). Dat is de meest voorkomende vorm en betekent dat er
  op hook-tijd nog niets gestaged is: bepaal de review-scope dan op de working tree
  (`git diff HEAD` plus untracked bestanden), niet op de index.
- Scope-bepaling in volgorde: bevat het commando een `add`/`-a` → working tree;
  anders → `git diff --cached`; bij `--amend` → `HEAD~1..` plus staged.
- Sla over (allow, exit 0) bij: lege diff, alleen wijzigingen in genegeerde paden
  (configureerbaar, standaard lockfiles en `dist/`), diff kleiner dan `minLines` (standaard 0,
  dus uit), of als `REVIEWGATE_SKIP=1` in de omgeving staat.
- `--no-verify` in het commando: blokkeren met een duidelijke reden. Voeg dit ook toe als
  permission deny-rule in de projectinstellingen, want agents grijpen ernaar als iets faalt.

### Approval-artifact

Na Approve schrijft de server `.git/reviewgate/approved/<diffHash>.json` met de hash van de
gereviewde diff, tijdstip en sessie-id. De hook laat een commit door als er een geldig artifact
bestaat voor exact deze diff. Dat maakt het idempotent: als de agent na Approve nog een keer
`git commit` aanroept (bijvoorbeeld na een failing pre-commit hook van git zelf) hoef je niet
opnieuw te reviewen. Artifacts vervallen na 24 uur en bij elke diffwijziging.

`diffHash` = sha256 over de genormaliseerde patchtekst (paden + hunks, zonder timestamps
en zonder index-regels).

---

## 3. Architectuur

```
  Claude Code sessie
        │  Bash("git add -A && git commit -m ...")
        ▼
  PreToolUse hook  ──────────►  reviewgate hook   (blokkeert, wacht op verdict)
        ▲                              │
        │  allow / deny + feedback     │ start
        │                              ▼
        │                       review-server (127.0.0.1:<port>)
        │                        ├── git: diff, blob, blame
        │                        ├── sessiestore (.git/reviewgate)
        │                        └── chat-agent (read-only)
        │                              │ HTTP + SSE
        └──────────────────────────────┴──►  browser-UI (React)
                                                 Approve / Request changes
```

Eén proces per repo. De server schrijft `.git/reviewgate/server.json` met poort en pid;
een tweede aanroep in dezelfde repo hergebruikt de draaiende server. Poort: ephemeral,
binden op `127.0.0.1`. De review-URL bevat een random token; requests zonder token → 403.

---

## 4. Repo-indeling en stack

Node + TypeScript, pnpm workspaces. Eén npm-package die alles bundelt, plus een aparte
plugin-directory voor de Claude Code kant.

```
reviewgate/
├── packages/
│   ├── cli/            # bin: reviewgate. hook, open, serve, status
│   ├── core/           # git-interactie, diff parsing, anchoring, sessiemodel, rendering
│   ├── server/         # HTTP + SSE, serveert de gebouwde web-assets
│   └── web/            # React UI (Vite)
├── plugin/             # Claude Code plugin (wordt meegepubliceerd)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── bin/reviewgate-hook.mjs   # Node-wrapper, geen shellscript (§11)
│   ├── commands/review.md
│   └── skills/reviewgate/SKILL.md
├── e2e/                # Playwright
└── PLAN.md
```

Keuzes:

- **core** is puur en zonder IO waar mogelijk, zodat diff-parsing en comment-anchoring
  unit-testbaar zijn met vitest. Alle `git`-aanroepen achter één `GitClient` interface.
- Server: **Hono** op `@hono/node-server`. Native TS, ingebouwde `streamSSE`, geen platform-
  specifieke afhankelijkheden. SSE voor streaming chat, geen websockets nodig.
- **Platformneutraal is een harde eis, geen bijzaak.** Concreet:
  - Geen shellscripts in het uitvoerpad. Alle bins zijn `.mjs` met een shebang plus een
    `bin`-entry in `package.json`, zodat npm op Windows zelf een `.cmd`-shim genereert.
  - Nooit `child_process.exec` met een samengestelde commandostring. Altijd `execFile`/`spawn`
    met een argv-array en `shell: false`, zodat quoting per platform geen rol speelt.
  - Paden altijd via `node:path`; vergelijken en opslaan in POSIX-vorm (`path.posix`,
    forward slashes), want dat is ook wat `git` teruggeeft. Converteer alleen bij het
    daadwerkelijke filesystem-contact.
  - Git-output lezen als UTF-8 met `core.quotePath=false`, en regeleindes splitsen op `\r?\n`.
    Houd rekening met `core.autocrlf` op Windows: parse de diff zoals git hem geeft, en
    normaliseer niet zelf.
  - Browser openen zonder `open`-achtige shell-aanroep: `start`/`open`/`xdg-open` per platform
    via `execFile`, met een zichtbare fallback die de URL in de terminal print.
  - Bestandsslot en pid-check in `.git/reviewgate/server.json` mogen niet op POSIX-signalen
    leunen; gebruik `process.kill(pid, 0)` in een try/catch, dat werkt op alle drie.
- Web: React + Vite + Tailwind, shiki voor highlighting (server-side gerenderde tokens
  schelen veel bundelgrootte en zijn sneller bij grote diffs).
- Diff parsen: eigen parser op `git diff -U5 --no-color` output, of `parse-diff` als startpunt.
  Je hebt hoe dan ook eigen structuren nodig voor anchoring, dus houd de parser dun.
- Geen database. JSON-bestanden in `.git/reviewgate/` — dat pad zit al buiten versiebeheer.

---

## 5. Datamodel

`.git/reviewgate/reviews/<reviewId>.json`

```ts
type Review = {
  id: string; // stabiel over meerdere rondes heen
  repoRoot: string;
  branch: string;
  createdAt: string;
  rounds: Round[]; // elke commit-poging voegt een ronde toe
  comments: Comment[];
  suggestions: Suggestion[]; // van de automatische pass, geen comments (§9)
  chat: ChatMessage[];
  status: "open" | "approved" | "changes_requested" | "abandoned";
};

type Round = {
  n: number;
  diffHash: string;
  scope: "staged" | "working" | "amend";
  commitMessage: string | null; // uit het onderschepte commando
  editedCommitMessage: string | null; // door jou aangepast in de UI, null = ongewijzigd
  claudeSessionId: string;
  transcriptPath: string | null;
  decision: "approve" | "request_changes" | "timeout" | null;
  decidedAt: string | null;
  summary: string | null; // vrij tekstveld bij de beslissing
};

type Comment = {
  id: string;
  round: number; // ronde waarin hij geplaatst is
  scope: "global" | "line" | "commit_message";
  kind: "issue" | "question"; // vragen worden met ? gerenderd in de feedback
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string; // de daadwerkelijke regeltekst, voor re-anchoring
  body: string;
  author: "user" | "agent";
  status: "open" | "resolved" | "outdated";
  fromSuggestion?: string; // id van de suggestie waar hij uit voortkomt
  replies: { author: "user" | "agent"; body: string; at: string }[];
  createdAt: string;
};

type Suggestion = {
  id: string;
  round: number;
  scope: "global" | "line" | "commit_message";
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
  body: string;
  severity: "blocker" | "aandachtspunt" | "nit";
  status: "pending" | "accepted" | "dismissed";
  dismissedReason?: "user" | "auto_duplicate" | "round_closed";
  duplicateOf?: string; // id van de eerder afgewezen suggestie
  promotedToCommentId?: string;
  createdAt: string;
};
```

Suggesties zijn bewust een eigen type en géén `Comment` met `author: 'agent'`. Ze tellen niet
mee in de knop-state, gaan niet mee in de feedback naar Claude, en worden pas een comment als
jij ze overneemt. Ze worden ook nooit verwijderd: afgewezen suggesties blijven in het bestand
en in de UI staan, zodat je kunt terugzien wat er is voorgesteld en wat je ermee hebt gedaan.
Zie §9.

### Anchoring over rondes heen

Dit is het lastigste stuk; plan er tijd voor in en dek het met unit tests.

Bij een nieuwe ronde verschuiven regelnummers. Per openstaande comment:

1. Zoek `anchorSnippet` terug in het nieuwe bestand binnen een venster van ±40 regels
   rond het oude nummer. Exacte match → verplaats de comment.
2. Precies één match elders in het bestand → verplaats en markeer als `moved`.
3. Geen of meerdere matches → status `outdated`. Blijft zichtbaar in de UI in een
   "Outdated" sectie, zoals GitLab dat doet, en telt niet meer mee als openstaand.

Comments van eerdere rondes blijven zichtbaar met een rondenummer-badge, zodat je bij
ronde 2 kunt zien of je eerdere punten daadwerkelijk zijn opgevolgd.

---

## 6. CLI

```
reviewgate hook                 # leest hook-JSON van stdin, blokkeert, print verdict-JSON
reviewgate open [ref]           # handmatige review: --staged (default), --working, main...HEAD
reviewgate serve                # server zonder review starten (dev)
reviewgate status               # draaiende server, open reviews, laatste beslissing
reviewgate approve <id>         # approven vanaf de terminal, weigert bij openstaande comments
```

`reviewgate hook` moet testbaar zijn zonder Claude Code:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m test"}}' \
  | reviewgate hook
```

---

## 7. Server-API

Alles onder `/api`, token in de `Authorization` header of de query van de review-URL.

```
GET  /api/review/:id                 → Review + gerenderde diff (files, hunks, tokens)
GET  /api/review/:id/file?path=&side= → volledige bestandsinhoud voor context-expansie
POST /api/review/:id/comments        → nieuwe comment (global, line of commit_message)
PATCH/DELETE /api/review/:id/comments/:cid
POST /api/review/:id/comments/:cid/replies
PUT  /api/review/:id/commit-message  → { message } → slaat editedCommitMessage op
POST /api/review/:id/suggestions/:sid/accept   → { body? } → promoveert naar comment
POST /api/review/:id/suggestions/:sid/dismiss
POST /api/review/:id/decision        → { decision, summary } → sluit de ronde, deblokkeert de hook
GET  /api/review/:id/events          → SSE: comment- en suggestie-mutaties, chat-tokens, decision
POST /api/review/:id/chat            → { message } → antwoord streamt over de SSE
```

`POST /decision` met `approve` valideert server-side op nul openstaande comments en geeft
anders `409` met de betreffende id's. Openstaande suggesties blokkeren niets: die krijgen bij
een beslissing `status: 'dismissed'` met `dismissedReason: 'round_closed'` en blijven zichtbaar
in de historie.

De hook wacht op een promise die door `POST /decision` wordt geresolved. Werk met een
in-memory `Deferred` per ronde plus een fallback die het sessiebestand pollt, zodat een
serverherstart de hook niet eeuwig laat hangen.

---

## 8. UI

### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  feature/checkout · ronde 2 · 7 files · +214 −38        [ Unified | Split ] │
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ Bestanden    │  diff                                    │  Gesprek         │
│              │                                          │                  │
│ ✓ Foo.php  2 │  @@ -40,7 +40,12 @@                      │  Waarom is de    │
│   Bar.ts     │   40   public function handle()          │  cache hier      │
│   Baz.vue  1 │   41 + $this->cache->forget($key);   💬   │  geforget?       │
│              │        ┌────────────────────────────┐    │                  │
│ Overzicht    │        │ open · ronde 1             │    │  ──────────      │
│  · 1 globaal │        │ Dit invalidatie-pad mist   │    │  [ vraag... ]    │
│              │        │ de tag-variant.            │    │                  │
│              │        │ [Reageer] [Resolve]        │    │                  │
│              │        └────────────────────────────┘    │                  │
├──────────────┴──────────────────────────────────────────┴──────────────────┤
│ 3 openstaand · 1 verouderd     [samenvatting...]        [ Request changes ]│
└────────────────────────────────────────────────────────────────────────────┘
```

Drie kolommen, resizable, met de bestandenlijst en het chatpaneel inklapbaar. De actiebalk
staat vast onderaan en is altijd zichtbaar — dat is de kern van het scherm.

### Interacties

- Klik op het `+`-icoon in de goot van een regel → comment-form op die regel.
  Slepen over meerdere regels → range-comment, met de range gemarkeerd in de goot.
- Comments zitten inline onder de betreffende regel, ingeklapt tot een balkje met auteur en
  eerste regel als het bestand veel comments heeft.
- Globale comments in het "Overzicht"-tabblad boven de bestandenlijst.
- Suggesties van de automatische pass staan visueel apart: gestippelde rand, badge "Voorstel"
  met severity, gedempte kleur, en nooit dezelfde vorm als een echte comment. Per suggestie
  drie acties: **Overnemen** (opent het comment-form met de tekst voorgevuld en bewerkbaar,
  zodat je hem in je eigen woorden kunt zetten), **Afwijzen**, en **Bespreken** (stuurt hem
  naar het chatpaneel). Zolang je niets doet blijft het een voorstel en verandert er niets.
  Afgewezen voorstellen blijven bestaan, ingeklapt onder "Afgewezen (n)" (§9).
- Context-expansie: knop tussen hunks om ±10 regels bij te laden, en "hele bestand tonen".
- Toetsenbord: `j`/`k` volgende/vorige hunk, `n`/`p` volgend/vorig bestand, `c` comment op de
  actieve regel, `⌘↵` versturen, `⌘⇧↵` de primaire actie uitvoeren.
- Zichtbare focus states, `prefers-reduced-motion` respecteren. Motion alleen waar iets
  verandert: het openklappen van een comment en de wissel van de primaire knop.

### De commit message

Bovenaan het "Overzicht"-tabblad, boven de globale comments, met twee onafhankelijke routes:

- **Bewerken.** De message die Claude uit het onderschepte commando wilde gebruiken staat in
  een textarea. Wat je erin typt wordt de message. Bij Approve schrijft de hook je versie naar
  `.git/reviewgate/COMMIT_EDITMSG` en herschrijft hij het commando met `updatedInput` naar
  `git commit -F <pad>` — dat vermijdt alle quoting-ellende met meerregelige messages en
  aanhalingstekens. Bij Request changes gaat je versie mee in de feedback als de te gebruiken
  message.
- **Becommentariëren.** Een comment-knop naast het veld plaatst een comment met
  `scope: 'commit_message'`. Die telt gewoon mee als openstaand en zet de knop dus op Request
  changes. Gebruik dit als je wil dat Claude de message zélf herziet ("verwijs naar het
  ticket, en splits dit in twee commits") in plaats van dat jij hem even goed zet.

Beide mogen tegelijk: een bewerkte message plus een comment erover is een geldige combinatie.
Toon in dat geval bij de comment een hint dat de message inmiddels ook is aangepast, zodat de
feedback voor Claude niet tegenstrijdig oogt. De originele message blijft altijd zichtbaar
achter een "toon origineel"-toggle.

### De actieknop (state machine)

Dit is een expliciete eis; implementeer het als één knop die van rol wisselt, niet als twee
knoppen naast elkaar.

```
openComments = comments.filter(c => c.status === 'open').length

openComments === 0  →  primair: "Approve"          (groen, ⌘⇧↵)
openComments  >  0  →  primair: "Request changes"  (oranje, ⌘⇧↵)
```

- De wissel is live: zodra je de eerste comment plaatst verandert het label, en als je je
  laatste openstaande comment resolvet of verwijdert springt hij terug naar Approve.
- Verouderde (`outdated`) en opgeloste comments tellen niet mee.
- Openstaande suggesties tellen ook niet mee. Een voorstel dat je niet hebt overgenomen mag
  de knop niet omzetten — anders bepaalt de agent alsnog of jij mag approven.
- Naast de knop staat de teller die de staat verklaart ("3 openstaand"), zodat de wissel
  nooit als een bug voelt.
- Animatie: alleen een korte kleur- en labelcrossfade, geen layout shift. Reserveer de
  breedte van het langste label.
- **Geen ontsnappingsroute.** Er is geen tweede knop, geen caret-menu en geen "approve met
  opmerkingen". Met openstaande comments is Request changes de enige mogelijke actie. Wil je
  toch approven, dan resolve of verwijder je eerst de comments — dat is een bewuste handeling
  die zichtbaar in de historie staat, in plaats van een afwijking die je wegklikt.
- Dit wordt server-side afgedwongen, niet alleen in de UI: `POST /decision` met
  `decision: "approve"` terwijl er openstaande comments zijn geeft `409` met de lijst van
  openstaande comment-id's. De UI is daarmee niet de enige plek waar de regel leeft.
- Vragen zijn ook comments en houden de knop dus op Request changes. Ze worden in de feedback
  met `?` gemarkeerd, zodat Claude ze beantwoordt in plaats van blind te fixen.

### De samenvatting

Het tekstveld links van de actieknop. Eén of twee zinnen over de review als geheel, die als
`## Samenvatting` bovenaan de feedback aan Claude komen te staan — bij Approve gaat hij mee via
`additionalContext`.

Het is bewust iets anders dan de comments. Comments zijn punt-voor-punt en lokaal; de
samenvatting geeft de richting en de volgorde: "de opzet klopt, maar los eerst de
cache-invalidatie op — de rest volgt daaruit", of "dit is te groot, splits het in twee commits".
Precies het soort framing dat je in een MR in het beschrijvingsveld zet en dat uit een lijst
losse opmerkingen niet af te leiden is.

Optioneel, en dat blijft het ook. Placeholder maakt duidelijk waar het voor is ("Richting voor
de volgende ronde, optioneel"). Laat je hem leeg, dan wordt het kopje weggelaten uit de feedback
in plaats van leeg meegestuurd. Geen hint, geen nudge en geen waarschuwing als je approvet
zonder iets in te vullen — een lege samenvatting is een geldige review.

### Visuele richting

Geen GitLab-kloon en geen generieke SaaS-kaartjes. Het scherm is een leesomgeving voor code
die in de terminalcontext van Claude Code opent, dus: rustige, dichte layout, alle ruimte naar
de diff, chrome zo dun mogelijk. Kies bewust één monospace-familie voor de code en één
sans voor de UI, en stel de kleuren van de diff-achtergronden zo af dat ze bij lange sessies
niet vermoeien (lage saturatie voor de vlakken, hoge saturatie alleen voor de per-teken
highlight binnen een gewijzigde regel). Bepaal palet en typografie in één keer als tokens
voor je begint met bouwen, en houd de enige echt uitgesproken plek de actiebalk onderaan.

---

## 9. Chatpaneel

Het paneel beantwoordt vragen over de changes terwijl je reviewt. Twee dingen maken het beter
dan de diff in een los chatvenster plakken:

1. **Repo-toegang.** Draai de chat via de Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
   met `cwd` op de repo en `allowedTools: ['Read', 'Grep', 'Glob']`. Read-only, expliciet
   zonder Edit/Write/Bash — de hoofdsessie staat geblokkeerd te wachten en er mag niets
   onder handen veranderen. Antwoorden streamen via SSE naar de UI.
2. **Intentie.** De hook krijgt `transcript_path` van de blokkerende sessie mee. Geef de chat
   dat transcript als context (of een samenvatting ervan bij grote transcripts), zodat
   "waarom heb je hier een repository omheen gezet?" beantwoord wordt met wat er in de sessie
   is besloten, in plaats van met een gok op basis van de code.

Systeemprompt van de chat: je bent een reviewer-assistent, je legt uit en analyseert, je wijzigt
niets, je bent expliciet over wat je uit het transcript weet en wat je uit de code afleidt.

De diff, de bestandenlijst en de al geplaatste comments gaan mee als context. Per bericht
stuur je de volledige geschiedenis mee, of gebruik je session resume van de SDK.

Twee koppelingen tussen chat en review, allebei belangrijk:

- **"Maak hier een comment van"** op elk chatantwoord → opent het comment-form met de
  betreffende file/regel voorgevuld als het antwoord naar code verwijst.
- **"Vraag het de auteur"** → zet je vraag als comment met `kind: question` in de review.
  Die gaat bij Request changes mee terug naar de hoofdsessie als vraag, niet als opdracht.

Fallback als de Agent SDK niet beschikbaar is of er geen auth is: directe Anthropic API-call met
alleen de diff als context, en een melding in de UI dat de repo-context ontbreekt.

### Automatische eerste pass

Zodra het scherm opent start dezelfde read-only agent een review-pass over de diff en plaatst
zijn bevindingen als **suggesties**, niet als comments. Het onderscheid is de hele kern van
deze feature: de agent mag je aandacht ergens op vestigen, maar mag niet namens jou een
oordeel in de review zetten.

Concreet:

- Suggesties verschijnen progressief via SSE terwijl de pass loopt; jij kunt intussen al
  lezen en zelf comments plaatsen. De pass blokkeert niets.
- Status van de pass staat in de kopbalk: "voorstellen zoeken…", "6 voorstellen", of
  "voorstellen mislukt" met de reden. Nooit een modal, nooit een spinner over de diff heen.
- Een suggestie wordt pas een comment als je op **Overnemen** klikt, en dan opent het
  comment-form met de tekst voorgevuld en bewerkbaar. De comment die eruit komt heeft
  `author: 'user'` met `fromSuggestion` gevuld — jij bent de auteur, want jij hebt hem
  goedgekeurd. Alleen dan telt hij mee voor de knop en gaat hij mee in de feedback.
- Niet-overgenomen suggesties gaan nooit naar Claude. Hij hoort zijn eigen ongefilterde review
  niet terug te krijgen.
- Severity (`blocker` / `aandachtspunt` / `nit`) is alleen een sorteervolgorde in de UI, geen
  gedrag. Sorteer op severity, dan op bestand en regelnummer.
- De prompt van de pass krijgt dezelfde context als de chat (diff, transcript, repo read-only)
  plus de `CLAUDE.md` en eventuele `REVIEW.md` van het project, en de instructie om terughoudend
  te zijn: concrete defecten op `file:line`, geen stijlvoorkeuren, geen dingen die de linter al
  vangt.
- De pass deelt de agentsessie met het chatpaneel, zodat je in de chat kunt doorvragen op een
  voorstel zonder dat de context opnieuw opgebouwd wordt.
- Uitschakelbaar met `autoReview: false` in `.reviewgate.json`, en handmatig opnieuw te starten
  met een knop in de kopbalk.

### Hoeveel voorstellen

De cap schaalt mee met de omvang van de diff: **2 voorstellen per 50 gewijzigde regels**.

```
changedLines = alle + en − regels in de review-scope, ignore-patronen niet meegeteld
cap = clamp(ceil(changedLines / 25), 2, 20)
```

Dus 50 regels → 2, 200 regels → 8, 500 regels → 20. De ondergrens van 2 zorgt dat een diff van
tien regels niet automatisch nul voorstellen mag opleveren; de bovengrens van 20 is een
veiligheidsklep tegen een muur van tekst bij een enorme refactor. Beide getallen configureerbaar
via `autoReview.perLines`, `autoReview.min` en `autoReview.max`.

Twee dingen die hierbij horen en die je in de prompt én in de code moet vastleggen:

- **Het is een plafond, geen doel.** Nul voorstellen is een geldige en vaak juiste uitkomst.
  Zet dat expliciet in de prompt ("noem alleen wat daadwerkelijk iets toevoegt; als er niets is,
  lever een lege lijst") en toon in de UI bij nul voorstellen niets meer dan een rustige regel
  in de kopbalk. Geen lege-staat-illustratie, geen "geen problemen gevonden!"-melding.
- **De cap wordt server-side afgedwongen**, niet alleen gevraagd in de prompt. Levert de agent
  er meer, dan houd je de hoogste severity aan, daarna bestandsvolgorde en regelnummer.
  De afgekapte voorstellen komen in het sessiebestand terecht voor debugging, maar niet in de UI.
- De cap telt alleen `pending` voorstellen. Automatisch afgewezen duplicaten (hieronder) tellen
  niet mee, anders verdringt de historie de nieuwe bevindingen.

### Herhaalde voorstellen over rondes heen

Afgewezen voorstellen verdwijnen nooit. Ze blijven in het reviewbestand staan en blijven in de
UI zichtbaar, en ze onderdrukken herhaling in latere rondes:

- De afgewezen voorstellen gaan als context mee naar de pass van de volgende ronde, met de
  instructie ze niet te herhalen.
- Doet hij het toch, dan wordt het nieuwe voorstel **automatisch afgewezen** in plaats van
  weggegooid: `status: 'dismissed'`, `dismissedReason: 'auto_duplicate'`, `duplicateOf` verwijst
  naar het origineel. Het staat er dus wel, met een label als "automatisch afgewezen — je hebt
  dit in ronde 1 al afgewezen" en een knop om het alsnog te heropenen. Jij houdt het laatste
  woord; de deduplicatie neemt alleen het klikwerk weg.
- Matching is deterministisch en unit-testbaar, geen model-oordeel. Normaliseer de tekst
  (lowercase, leestekens en regelnummers eruit, whitespace inklappen) en vergelijk met
  Jaccard-similariteit over woord-trigrammen. Duplicaat als: zelfde bestand én overlappende
  regelrange én similariteit ≥ 0.6, óf similariteit ≥ 0.8 ongeacht locatie. Drempels
  configureerbaar, en log bij elke automatische afwijzing de score zodat je ze kunt bijstellen.
- Alleen voorstellen die _jij_ hebt afgewezen (`dismissedReason: 'user'`) en eerder automatisch
  afgewezen duplicaten onderdrukken herhaling. Voorstellen die bij de beslissing zijn gesloten
  omdat je er simpelweg niet aan toekwam (`round_closed`) niet — die had je nooit beoordeeld,
  dus die mogen terugkomen.
- In de UI staan afgewezen voorstellen ingeklapt onder "Afgewezen (n)", per bestand en in het
  overzicht, met hun rondenummer. Ze tellen nooit mee voor de knop.

---

## 10. Feedback-formaat terug naar Claude

`permissionDecisionReason` bij Request changes. Houd het compact en machineleesbaar-genoeg
dat Claude er direct op kan werken:

```markdown
# Code review: changes requested (ronde 2)

De commit is geblokkeerd. Verwerk onderstaande punten, en probeer daarna opnieuw te committen.
Vragen (gemarkeerd met ?) beantwoord je in je antwoord aan de gebruiker; die hoef je niet te fixen.

## Samenvatting

<vrije tekst van de reviewer>

## Commit message

Gebruik deze message (aangepast door de reviewer):

    fix(checkout): invalideer cache-tags bij order-annulering

    Refs #412

- Splits dit in twee commits: de cache-fix en de refactor van de service horen niet bij elkaar.

## Algemeen

- De nieuwe service hoort in `app/Services/`, niet in `app/Support/`.

## app/Services/CheckoutService.php

- L42-48: het invalidatie-pad mist de tag-variant, waardoor de cache blijft staan.
- ? L91: waarom hier een transactie omheen, terwijl er maar één write is?

## resources/js/checkout.ts

- L17: deze fetch heeft geen error-afhandeling.

## Nog open uit ronde 1

- app/Models/Order.php L23: nog niet opgelost.
```

Het blok "Commit message" verschijnt alleen als de message is bewerkt of als er een comment met
`scope: 'commit_message'` open staat, en bevat dan allebei die dingen: eerst de te gebruiken
message, daarna de comments erover.

Bij Approve: `allow`. Er zijn per definitie geen openstaande punten meer. Wat er nog meegaat:

- Is de message bewerkt, dan schrijft de hook hem naar `.git/reviewgate/COMMIT_EDITMSG` en
  vervangt hij het commando via `updatedInput` door `git commit -F <pad>` (met de overige
  vlaggen intact). Dit is het enige moment waarop ReviewGate het commando van de agent
  herschrijft; log het naar `hook.log` en toon het in de UI in de bevestiging.
- De samenvatting gaat mee via `additionalContext`, zodat Claude weet waarop is goedgekeurd.

---

## 11. Plugin-verpakking

```
plugin/
├── .claude-plugin/plugin.json     # alleen dit bestand hoort in .claude-plugin/
├── hooks/hooks.json
├── bin/reviewgate-hook.mjs        # Node-wrapper, werkt op macOS, Linux en Windows
├── commands/review.md             # /reviewgate:review — handmatige review starten
└── skills/reviewgate/SKILL.md     # legt de agent uit wat de gate is en hoe hij feedback verwerkt
```

`hooks/hooks.json` gebruikt hetzelfde schema als het `hooks`-blok in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/reviewgate-hook.mjs\"",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

Gebruik altijd `${CLAUDE_PLUGIN_ROOT}`, nooit absolute paden. De wrapper is een Node-script,
geen shellscript: het commando wordt expliciet met `node` gestart, zodat het op Windows niet
van een POSIX-shell of van het `exec`-bit afhangt. Het script leest de hook-JSON van stdin,
roept `reviewgate hook` aan (lokale install, anders `npx`) via `execFile` met een argv-array,
en doet bij élke fout `exit 0` zonder output — een kapotte gate mag nooit het werk blokkeren,
alleen niet reviewen. Log fouten naar `.git/reviewgate/hook.log`.

Het commando dat de wrapper aanroept is zelf ook platformafhankelijk: `npx` heet op Windows
`npx.cmd`. Los dat op door de CLI-entry direct met `node` te starten (`node <pad>/cli.mjs hook`)
in plaats van de bin-shim aan te roepen, dan is er geen `.cmd`-geval.

In de README ook opnemen: zet in de `CLAUDE.md` van je project dat stagen en committen
gescheiden commando's moeten zijn, en voeg `--no-verify` toe aan de deny-rules.

---

## 12. Randgevallen en risico's

| Geval                                                | Aanpak                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `git add -A && git commit` in één Bash-call          | working tree als scope (§2)                                                                                          |
| Commit vanuit een subagent of parallelle sessie      | review per `session_id`; tweede sessie krijgt deny met "review al open"                                              |
| Server crasht terwijl de hook wacht                  | hook heeft eigen timeout, valt terug op deny met uitleg                                                              |
| Enorme diff (>2000 regels)                           | lazy per bestand laden, waarschuwing in de UI, geen full-file highlighting                                           |
| Binaire bestanden en renames                         | tonen als metadata-regel, wel becommentarieerbaar op bestandsniveau                                                  |
| Submodules, LFS                                      | v1: overslaan met een zichtbare notitie                                                                              |
| Merge commits, rebase, `git commit` tijdens conflict | detecteren via `.git/MERGE_HEAD` en de gate overslaan                                                                |
| Agent probeert de gate te omzeilen                   | `--no-verify`, `git stash`, direct `.git/`-schrijfacties in de deny-rules; PreToolUse deny geldt ook in bypass-modes |
| Repo zonder commits (geen HEAD)                      | scope tegen de lege boom                                                                                             |
| Windows                                              | first-class target, gelijk aan macOS/Linux (§4). Geen shellscripts, `execFile` met argv, paden via `node:path` |
| Paden met spaties of niet-ASCII tekens               | argv-arrays in plaats van commandostrings; `core.quotePath=false` bij het lezen van git-output                        |
| CRLF-checkouts (`core.autocrlf=true`)                | diff parsen zoals git hem levert, splitsen op `\r?\n`, zelf niet normaliseren                                        |

---

## 13. Fasering

Elke milestone is los bruikbaar en heeft een demo-moment. Niet vooruitwerken.

**M0 — Fundament**
Monorepo, TypeScript, vitest, CLI-skelet, `GitClient`, diff-parser.
Klaar als: `reviewgate open --staged --json` een correcte, getypeerde diffstructuur print
voor een testrepo met toevoegingen, verwijderingen, renames en een binair bestand.

**M1 — Diff lezen**
Server + web-UI, unified en split view, syntax highlighting, bestandenlijst, context-expansie.
Klaar als: `reviewgate open` een browser opent die de gestagede diff correct toont, inclusief
een diff van 1000+ regels zonder merkbare vertraging.

**M2 — Comments**
Globale comments, regel- en range-comments, replies, resolve, persistentie, SSE-sync.
Klaar als: comments overleven een herstart van de server en de juiste regel behouden.

**M3 — De gate (eerste echt bruikbare versie)**
Actiebalk met de knop-state-machine, `POST /decision` met server-side validatie, blokkerende
hook, approval-artifact, bewerkbare en becommentarieerbare commit message inclusief
`updatedInput`-herschrijving, feedback-rendering. Plugin-skelet met `hooks.json`.
Klaar als: in een echte Claude Code sessie een commit blokkeert, jij comments plaatst,
Request changes drukt, en Claude de feedback ontvangt en aan het werk gaat. Vanaf hier
reviewt ReviewGate zijn eigen commits.

**M4 — Chat en suggesties**
Agent SDK read-only, SSE-streaming, transcript-context, "maak hier een comment van", en de
automatische eerste pass die suggesties oplevert (§9).
Klaar als: een vraag over een regel wordt beantwoord met verwijzing naar een bestand dat
niet in de diff zit, én een suggestie pas na Overnemen de knop op Request changes zet.

**M5 — Rondes**
Meerdere rondes per review, anchoring en `outdated`-detectie, historie in de UI,
"vraag het de auteur".
Klaar als: een comment uit ronde 1 die door de fix van Claude verschoven is, in ronde 2 op
de juiste nieuwe regel staat.

**M6 — Uitleveren**
`.reviewgate.json` config (timeout, minLines, ignore-patronen, theme, autoOpen),
plugin publiceren via een marketplace-repo, README met screenshots, Playwright happy path,
foutafhandeling die nooit blokkeert.

---

## 14. Testaanpak

- **core**: unit tests op diff-parsing en anchoring, met fixtures van echte patches
  (verschoven regels, hernoemde bestanden, verwijderde hunks).
- **hook**: tabelgedreven tests met echte hook-payloads als JSON-fixtures, inclusief de
  `add && commit`-keten, `--amend`, `--no-verify` en lege diffs.
- **server**: integratietests tegen een tijdelijke git-repo die per test wordt opgezet.
- **e2e**: Playwright, één happy path (comment plaatsen → knop wisselt → request changes →
  hook krijgt deny met de juiste markdown) en één approve-path.
- De knop-state-machine krijgt eigen tests: dat is de eis waar het geheel op beoordeeld wordt.
- **CI-matrix over `windows-latest`, `macos-latest` en `ubuntu-latest`.** Platformneutraliteit
  die niet per commit getest wordt, is er na drie weken niet meer. Neem in de fixtures een
  pad met een spatie en een niet-ASCII bestandsnaam op, en draai de hooktests ook onder een
  CRLF-checkout.

---

## 15. Vastgelegde beslissingen

Deze zijn beantwoord en verwerkt in het plan. Ze staan hier zodat de reden zichtbaar blijft.

1. **Alleen `git commit` is een gate**, geen push-gate.
2. **Geen git-native `pre-commit` hook.** Eigen commits vanuit de terminal gaan ongehinderd door;
   de gate bewaakt de agent.
3. **Approve is onmogelijk met openstaande comments.** Geen escape hatch, server-side afgedwongen.
4. **Automatische eerste pass levert suggesties, geen comments.** Pas na Overnemen worden het
   comments van jou, en pas dan tellen ze mee en gaan ze naar Claude.
5. **De commit message is zowel bewerkbaar als becommentarieerbaar**, en die twee zijn
   onafhankelijk van elkaar te gebruiken.
6. **De cap op voorstellen schaalt mee met de diff**: 2 per 50 gewijzigde regels, met 2 als
   ondergrens en 20 als veiligheidsklep. Het is een plafond, geen doel — nul is prima.
7. **Afgewezen voorstellen verdwijnen nooit** en onderdrukken herhaling: een vrijwel identiek
   voorstel in een latere ronde wordt automatisch afgewezen, maar blijft zichtbaar en is
   handmatig te heropenen.
8. **De samenvatting is optioneel** en blijft een vrij tekstveld dat de richting van de review
   beschrijft (§8), niet een verplichte samenvatting van de comments. Geen hint of nudge als
   je hem leeg laat.
9. **Platformneutraal, met Windows als first-class target.** De hookwrapper is een Node-script
   (`.mjs`) dat expliciet met `node` gestart wordt, niet een shellscript; alle subprocessen
   gaan via `execFile`/`spawn` met een argv-array en `shell: false`; paden lopen via
   `node:path` en worden intern in POSIX-vorm bewaard. Reden: de gate zit in het commit-pad
   van elke sessie, dus hij moet overal draaien waar Claude Code draait — een `.sh` dat
   stilletjes faalt op Windows betekent een gate die er wel lijkt te zijn maar niets doet.
10. **Server is Hono** op `@hono/node-server`, met `streamSSE` voor de chat. Gekozen boven
    Express omdat het native TypeScript is, SSE ingebouwd heeft en geen platformspecifieke
    afhankelijkheden meebrengt.

### Bij te stellen tijdens gebruik

Geen open ontwerpvragen meer. Wel één instelling die pas met echte data te bepalen is: de
drempels voor duplicaatdetectie (0.6 bij overlappende regels, 0.8 daarbuiten). Log elke
automatische afwijzing met bestand, beide teksten en de score naar
`.git/reviewgate/dedupe.log`, en stel na een week echt gebruik bij. Te laag betekent dat je
nieuwe bevindingen mist doordat ze op oude lijken; te hoog betekent dat je dezelfde opmerking
elke ronde opnieuw wegklikt. De log maakt zichtbaar welke van de twee je hebt.
