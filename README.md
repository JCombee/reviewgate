# ReviewGate

Een lokale, browser-gebaseerde code review gate die opent zodra Claude Code wil
committen. Claude Code kan niet committen zonder dat er een menselijke beslissing
is geweest.

De diff opent in een browser-UI met syntax highlighting, unified en split view,
comments op regel- en bereikniveau, en één actieknop die wisselt tussen **Approve**
en **Request changes**. Bij Request changes komt alle feedback gestructureerd terug
in de Claude Code sessie, die daarna de fixes doet en opnieuw probeert te committen.

Alles draait op `127.0.0.1`. Geen hosting, geen accounts, geen data die de machine
verlaat behalve wat de assistent zelf aan Claude vraagt.

## Hoe het werkt

Een PreToolUse-hook onderschept elk `Bash`-commando, herkent een `git commit`, en
blokkeert synchroon tot er in de UI een beslissing valt:

| Beslissing in de UI | Hook output | Gevolg |
| --- | --- | --- |
| Approve | `permissionDecision: "allow"` | het commando loopt gewoon door |
| Request changes | `deny` + alle feedback in `permissionDecisionReason` | Claude ziet de review als feedback en gaat fixen |
| Timeout | `deny` met korte uitleg | Claude wacht op je, en commit niet |

Een `deny` van een PreToolUse-hook geldt in élke permission mode, ook onder
`--dangerously-skip-permissions`. De gate is dus niet te omzeilen door de agent.

## Installatie

```bash
pnpm install
pnpm build
```

Zet daarna de hook aan. In een project met de plugin:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/pad/naar/reviewgate/plugin/bin/reviewgate-hook.mjs\"",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

De wrapper is een Node-script en wordt expliciet met `node` gestart: zo werkt de
gate op macOS, Linux en Windows gelijk, zonder afhankelijkheid van een POSIX-shell.

### Aanbevolen projectinstellingen

Zet in de `CLAUDE.md` van je project dat stagen en committen gescheiden commando's
moeten zijn. Met `git add -A && git commit` staat er op hook-tijd nog niets in de
index, dus reviewt de gate de hele working tree in plaats van wat er gecommit wordt.

Voeg `--no-verify` toe aan de deny-rules van je project. De gate weigert het al met
een duidelijke melding, maar een deny-rule scheelt de poging.

## Gebruik zonder commit

```
reviewgate open [revisie]   review-scope inlezen en openen in de browser
    --staged                (default) de gestagede wijzigingen
    --working               index + working tree tegen HEAD
    --amend                 de wijzigingen van een amend
    <rev>                   een revisie-expressie, bijv. main...HEAD
    --json                  print de getypeerde diffstructuur en stop
    --no-open               browser niet openen, alleen de URL printen
    -U, --context <n>       contextregels (default 5)
    -C, --cwd <pad>         werk in een andere repo

reviewgate serve            server starten zonder review
reviewgate status           draaiende server en open reviews
reviewgate hook             PreToolUse-hook: leest hook-JSON van stdin en blokkeert
```

## In de review

- **Comments plaatsen.** Klik in de goot voor een comment op die regel, of sleep
  over meerdere regels voor een bereik. Het kan aan beide kanten van de diff.
- **Vragen.** Vink "Dit is een vraag" aan. Vragen komen met een `?` in de feedback,
  zodat Claude ze beantwoordt in plaats van blind te fixen.
- **De commit message** is zowel bewerkbaar als becommentarieerbaar, onafhankelijk
  van elkaar: zet hem zelf goed, óf vraag Claude hem te herzien, of allebei.
- **Voorstellen.** Zodra het scherm opent doet een read-only assistent een
  review-pass en plaatst zijn bevindingen als *voorstellen*, niet als comments. Ze
  tellen niet mee en gaan niet naar Claude tot jij ze overneemt. Afgewezen
  voorstellen blijven zichtbaar en komen in een volgende ronde niet terug.
- **Het gesprek** naast de diff beantwoordt vragen over de wijziging. De assistent
  leest de repo en het transcript van de sessie die de code schreef, en wijzigt niets.
- **Approve kan niet met openstaande comments.** Geen escape hatch: resolve of
  verwijder ze eerst. Dat wordt server-side afgedwongen, niet alleen in de UI.

### Toetsenbord

| Toets | Doet |
| --- | --- |
| `j` / `k` | volgende / vorige hunk |
| `n` / `p` | volgend / vorig bestand |
| `u` | wissel tussen unified en split |
| `⌘↵` | versturen (comment of vraag) |
| `⌘⇧↵` | de primaire actie uitvoeren |

## Configuratie

`.reviewgate.json` in de repo-root. Alles is optioneel:

```json
{
  "timeoutMs": 3300000,
  "minLines": 0,
  "ignore": ["pnpm-lock.yaml", "dist/**", "**/*.min.js"],
  "autoOpen": true,
  "autoReview": { "perLines": 25, "min": 2, "max": 20 },
  "dedupe": { "overlapping": 0.6, "anywhere": 0.8 },
  "theme": "system"
}
```

| Sleutel | Betekenis |
| --- | --- |
| `timeoutMs` | hoe lang de hook maximaal blokkeert |
| `minLines` | diffs kleiner dan dit gaan zonder review door; 0 zet het uit |
| `ignore` | paden die niet meetellen; `**` overspant mappen, `*` blijft binnen één segment |
| `autoOpen` | browser automatisch openen |
| `autoReview` | `false` zet de automatische pass uit; een object stelt de grenzen in |
| `dedupe` | drempels voor het herkennen van herhaalde voorstellen |
| `theme` | `system`, `light` of `dark` |

Een kapotte of onleesbare config levert de standaardwaarden op. Een fout in de
configuratie mag het werk niet blokkeren, hoogstens niet reviewen zoals bedoeld.

### Omgevingsvariabelen

| Variabele | Doet |
| --- | --- |
| `REVIEWGATE_SKIP=1` | de gate helemaal overslaan |
| `REVIEWGATE_TIMEOUT_MS` | overschrijft `timeoutMs` |
| `REVIEWGATE_NO_OPEN=1` | browser niet openen |
| `REVIEWGATE_AUTO_REVIEW=0` | de automatische pass uitzetten |

## Wat er op schijf komt

Alles in `.git/reviewgate/`, dat pad zit al buiten versiebeheer:

| Bestand | Inhoud |
| --- | --- |
| `reviews/<id>.json` | de review: rondes, comments, voorstellen, gesprek |
| `approved/<diffHash>.json` | bewijs dat déze diff is goedgekeurd; vervalt na 24 uur |
| `server.json` | poort, pid en beheerstoken van de draaiende server |
| `COMMIT_EDITMSG` | de door jou aangepaste commit message |
| `hook.log` | fouten in de hook |
| `dedupe.log` | automatisch afgewezen voorstellen met hun similariteitsscore |

## Ontwikkelen

```bash
pnpm build          # core, server, cli en de web-bundel
pnpm test           # vitest: unit en integratie
pnpm test:e2e       # playwright: happy path en approve path
pnpm typecheck
```

De hook is los te testen, zonder Claude Code:

```bash
echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m test"}}' \
  | reviewgate hook
```

## Grenzen

- Eén gebruiker, één machine. Geen remote reviews, geen accounts.
- Geen GitHub- of GitLab-integratie.
- Geen editing van code in de UI. De UI produceert feedback; de agent past aan.
- Alleen `git commit` is een gate, `git push` niet.
- Geen git-native `pre-commit` hook: commits die je zelf vanuit de terminal maakt
  gaan ongehinderd door. De gate bewaakt de agent, niet jou.
